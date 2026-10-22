import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError, QajitsuError, loadApprovedPlan, sha256, type Plan } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** One decision of a person about a generated spec (REQ-VER-24/AC4). */
export interface SpecReviewDecision {
  /**
   * `rewritten`: the author wrote the spec again after a send-back, a person decides next; `rewrite_failed`: the
   * author could not, and the case stays BLOCKED (the author gets one try per send-back, REQ-VER-24/AC3).
   */
  readonly decision: "accept" | "send_back" | "rewritten" | "rewrite_failed";
  readonly reviewer: string;
  /** SHA-256 of the spec the decision is about. */
  readonly sha256: string;
  readonly at: string;
  readonly reason?: string;
}

const reviewsOf = (data: Readonly<Record<string, unknown>>): Record<string, SpecReviewDecision[]> =>
  (data["specReviews"] ?? {}) as Record<string, SpecReviewDecision[]>;

/**
 * Whether specs of this run wait for a person (REQ-VER-24/AC1): `--review-specs`, `spec_review.always`, or one of the
 * project's first `spec_review.first_runs` executed runs. Off by default.
 *
 * @param config - `spec_review` of the project.
 * @param flag - `qj run --review-specs`.
 * @param executedRuns - Executed runs of the project before this one.
 */
export function specReviewOn(
  config: { readonly first_runs: number; readonly always: boolean },
  flag: boolean,
  executedRuns: number,
): boolean {
  return flag || config.always || executedRuns < config.first_runs;
}

/** Records one decision in `run.json` and the journal (REQ-VER-24/AC4). */
export async function recordSpecReview(
  session: Pick<RunSession, "ws" | "events" | "masker">,
  caseId: string,
  raw: SpecReviewDecision,
): Promise<void> {
  const { ws, events } = session;
  // A reviewer's reason is free text: masked before it is stored, like everything else (invariant 8).
  const decision = raw.reason === undefined ? raw : { ...raw, reason: session.masker.maskText(raw.reason) };
  const all = reviewsOf(ws.record.data);
  await ws.update({
    data: { ...ws.record.data, specReviews: { ...all, [caseId]: [...(all[caseId] ?? []), decision] } },
  });
  const actor =
    decision.decision === "rewritten" || decision.decision === "rewrite_failed"
      ? ({ kind: "agent", name: "author" } as const)
      : ({ kind: "user", name: decision.reviewer } as const);
  events.emit("run", actor, "spec.review", { caseId, ...decision });
}

/** The spec of a case next to its planned steps and expectations, for the reviewer (REQ-VER-24/AC2). */
export function reviewView(plan: Plan, caseId: string, code: string): string {
  const c = plan.cases.find((x) => x.id === caseId);
  const steps = (c?.steps ?? []).map(
    (s) =>
      `  ${s.id} ${s.action}${s.manual === true ? " (manual)" : ""}\n     expect ${JSON.stringify(s.expect)}`,
  );
  const lines = code.split("\n").map((l, i) => `${String(i + 1).padStart(3)}  ${l}`);
  return [
    `── ${caseId} ${c?.title ?? ""} (${c?.type ?? "?"}, sha256 ${sha256(code).slice(0, 12)})`,
    "Planned steps and expectations:",
    ...steps,
    "Spec:",
    ...lines,
    "",
  ].join("\n");
}

/** The outcome of reviewing the specs of a run. */
export interface SpecReviewOutcome {
  readonly accepted: ReadonlyMap<string, string>;
  /** Cases a person stopped, with the reason. */
  readonly blocked: ReadonlyMap<string, string>;
  /** Cases whose spec waits for a decision. */
  readonly waiting: readonly string[];
}

/**
 * Has a person review each generated spec before it runs (REQ-VER-24): in a terminal, each spec is shown next to its
 * planned steps and accepted or sent back with a reason; a spec sent back is written again once with the reason, and a
 * second send-back makes the case BLOCKED. Without a terminal, specs without an accepted decision wait (`qj
 * review-spec`). Only a decision on exactly the spec's SHA-256 counts. A review can only stop a spec (AC5).
 *
 * @param session - The run.
 * @param plan - The approved plan.
 * @param specs - Case id → spec file that passed the automatic checks.
 * @param io - Terminal.
 * @param options - Reviewer, clock, and how to write a spec again with a reviewer's reason.
 */
export async function reviewSpecs(
  session: Pick<RunSession, "ws" | "events" | "masker">,
  plan: Plan,
  specs: ReadonlyMap<string, string>,
  io: CommandIO,
  options: {
    readonly user: string;
    readonly now: () => Date;
    /** Writes the case's spec again with the reason; the new file, or nothing when that failed. */
    readonly rewrite: (caseId: string, reason: string) => Promise<string | undefined>;
  },
): Promise<SpecReviewOutcome> {
  const accepted = new Map<string, string>();
  const blocked = new Map<string, string>();
  const waiting: string[] = [];
  /** Writes a spec again once and records it, so the next decision is a person's even for identical code. */
  const rewrite = async (caseId: string, reason: string): Promise<string | undefined> => {
    const before = await readFile(specs.get(caseId) ?? "", "utf8").catch(() => "");
    const file = await options.rewrite(caseId, reason);
    if (file === undefined) {
      blocked.set(caseId, `the spec a reviewer sent back could not be written again: ${reason}`);
      await recordSpecReview(session, caseId, {
        decision: "rewrite_failed",
        reviewer: "author",
        sha256: sha256(before),
        at: options.now().toISOString(),
        reason,
      });
      return undefined;
    }
    await recordSpecReview(session, caseId, {
      decision: "rewritten",
      reviewer: "author",
      sha256: sha256(await readFile(file, "utf8")),
      at: options.now().toISOString(),
    });
    return file;
  };
  for (const [caseId, first] of specs) {
    let file: string | undefined = first;
    while (file !== undefined) {
      const code = await readFile(file, "utf8");
      const sha = sha256(code);
      const decisions = reviewsOf(session.ws.record.data)[caseId] ?? [];
      const sentBack = decisions.filter((d) => d.decision === "send_back");
      const last = decisions.at(-1);
      if (last?.decision === "accept" && last.sha256 === sha) {
        accepted.set(caseId, file);
        break;
      }
      if (last?.decision === "rewrite_failed") {
        blocked.set(caseId, `the spec a reviewer sent back could not be written again: ${last.reason ?? ""}`);
        break;
      }
      if (sentBack.length >= 2) {
        blocked.set(caseId, `a reviewer sent the spec back twice: ${sentBack.at(-1)?.reason ?? ""}`);
        break;
      }
      // Sent back without a terminal (qj review-spec): written again now, then reviewed again.
      if (last?.decision === "send_back" && last.sha256 === sha) {
        file = await rewrite(caseId, last.reason ?? "");
        continue;
      }
      if (!io.ask) {
        waiting.push(caseId);
        break;
      }
      io.write(reviewView(plan, caseId, code));
      const answer = (
        await io.ask(`Accept ${caseId}? [y] runs it; or type why it goes back to the author: `)
      ).trim();
      if (answer === "") {
        waiting.push(caseId);
        break;
      }
      const base = { reviewer: options.user, sha256: sha, at: options.now().toISOString() };
      if (/^(y|yes|accept)$/i.test(answer)) {
        await recordSpecReview(session, caseId, { decision: "accept", ...base });
        accepted.set(caseId, file);
        break;
      }
      await recordSpecReview(session, caseId, { decision: "send_back", ...base, reason: answer });
      if (sentBack.length + 1 >= 2) {
        blocked.set(caseId, `a reviewer sent the spec back twice: ${answer}`);
        break;
      }
      file = await rewrite(caseId, answer);
    }
  }
  return { accepted, blocked, waiting };
}

/** The error that stops a run whose specs wait for a person; the run continues after the review. */
export function specReviewPending(
  ticket: string,
  waiting: readonly string[],
  notRun: ReadonlyMap<string, string> = new Map(),
): ConfigError {
  // Cases that will not run are named too, so the person reviewing knows the whole picture (exploratory pass E5).
  const short = (reason: string): string => {
    const line = reason.split("\n")[0] ?? "";
    return line.length > 200 ? `${line.slice(0, 200)}…` : line;
  };
  const others = [...notRun].map(([caseId, reason]) => `\nNot run: ${caseId}: ${short(reason)}`).join("");
  return new ConfigError(
    "SPEC_REVIEW_PENDING",
    `${String(waiting.length)} spec(s) wait for a person's review: ${waiting.join(", ")}. Read them with qajitsu review-spec ${ticket}, decide with qajitsu review-spec ${ticket} --case <id> --accept (or --send-back "<reason>"), then run qajitsu run ${ticket} again.${others}`,
    { waiting },
  );
}

/**
 * Specs that wait only for a person (REQ-VER-24): every chosen case has a spec, none needs the author again, and some
 * have no decision on their current version. Such a run can stop before it builds an environment.
 *
 * @param ws - The run.
 * @param caseIds - The cases the run would execute.
 * @returns The waiting cases; empty when the run has to go on (a spec is missing, sent back, or all are accepted).
 */
export async function waitingForPerson(
  ws: Pick<RunSession["ws"], "record" | "path">,
  caseIds: readonly string[],
): Promise<string[]> {
  const waiting: string[] = [];
  for (const caseId of caseIds) {
    const code = await readFile(ws.path("specs", `${caseId}.spec.ts`), "utf8").catch(() => undefined);
    if (code === undefined) return [];
    const sha = sha256(code);
    const last = (reviewsOf(ws.record.data)[caseId] ?? []).at(-1);
    if (last?.decision === "send_back" && last.sha256 === sha) return [];
    if (last?.decision === "rewrite_failed") continue;
    if (!(last?.decision === "accept" && last.sha256 === sha)) waiting.push(caseId);
  }
  return waiting;
}

/** Lines for the report (REQ-VER-24/AC4): which specs a person reviewed, by whom, on which version. */
export function specReviewNotes(data: Readonly<Record<string, unknown>>): string[] {
  return Object.entries(reviewsOf(data)).flatMap(([caseId, all]) => {
    const decisions = all.filter((d) => d.decision === "accept" || d.decision === "send_back");
    const last = decisions.at(-1);
    if (last === undefined) return [];
    const back = decisions.filter((d) => d.decision === "send_back").length;
    return [
      last.decision === "accept"
        ? `${caseId}: spec reviewed and accepted by ${last.reviewer} (sha256 ${last.sha256.slice(0, 12)})${back > 0 ? ` after ${String(back)} send-back(s)` : ""}`
        : `${caseId}: spec sent back by ${last.reviewer}: ${last.reason ?? ""}`,
    ];
  });
}

/**
 * `qajitsu review-spec <TICKET> [--case <id>] [--accept | --send-back <reason>]`: reviews generated specs without a
 * terminal session (REQ-VER-24/AC2). Without a decision it shows the specs waiting for one.
 *
 * @returns 0 decided or shown, 2 nothing to review, 3 errors.
 */
export async function runReviewSpec(
  rawKey: string,
  options: {
    readonly run?: string | undefined;
    readonly case?: string | undefined;
    readonly accept?: boolean | undefined;
    readonly sendBack?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  user: string,
): Promise<number> {
  const masker = createMasker();
  try {
    if (options.accept === true && options.sendBack !== undefined)
      throw new ConfigError("REVIEW_DECISION_CONFLICT", "Use --accept or --send-back, not both.", {});
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws } = session;
    if (ws.record.data["results"] !== undefined)
      throw new ConfigError(
        "RUN_ALREADY_EXECUTED",
        "This run was executed; its specs cannot be reviewed any more.",
        {},
      );
    const plan = (await loadApprovedPlan(ws)).plan;
    const files = (await readdir(ws.path("specs")).catch(() => [] as string[]))
      .map((f) => /^(TC-\d{2,4})\.spec\.ts$/.exec(f)?.[1])
      .filter((x): x is string => x !== undefined && (options.case === undefined || x === options.case));
    if (files.length === 0) {
      io.write(
        options.case === undefined
          ? "No generated specs to review: run qajitsu run first.\n"
          : `No spec for ${options.case}.\n`,
      );
      return 2;
    }
    const decide = options.accept === true || options.sendBack !== undefined;
    if (decide && options.case === undefined)
      throw new ConfigError("REVIEW_CASE_MISSING", "A decision is about one spec: pass --case <id>.", {});
    for (const caseId of files) {
      const code = await readFile(join(ws.path("specs"), `${caseId}.spec.ts`), "utf8");
      if (!decide) {
        io.write(reviewView(plan, caseId, code));
        continue;
      }
      const base = { reviewer: user, sha256: sha256(code), at: ports.now().toISOString() };
      await recordSpecReview(
        session,
        caseId,
        options.accept === true
          ? { decision: "accept", ...base }
          : { decision: "send_back", ...base, reason: options.sendBack ?? "" },
      );
      io.write(
        options.accept === true
          ? `Accepted ${caseId} (sha256 ${base.sha256.slice(0, 12)}); qajitsu run ${ws.ticket} runs it.\n`
          : `Sent ${caseId} back; qajitsu run ${ws.ticket} has the author write it again with your reason.\n`,
      );
    }
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
