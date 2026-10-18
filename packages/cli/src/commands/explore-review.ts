import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CliExploreSessionSchema,
  ConfigError,
  ExploreSessionSchema,
  QajitsuError,
  ReviewRecordSchema,
  acceptedItems,
  recordDecisions,
  reviewItems,
  type CliExploreSession,
  type Plan,
  type ExploreSession,
  type ReviewItem,
  type ReviewRecord,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { runKnowledgeAdd, type KnowledgePorts } from "./knowledge.js";

/** Options of `qajitsu explore review`. */
export interface ExploreReviewOptions {
  readonly run?: string | undefined;
  readonly session?: string | undefined;
  /** Items to accept, e.g. `O1,C2`. */
  readonly accept?: string | undefined;
  /** Items to reject, e.g. `F1`. */
  readonly reject?: string | undefined;
  readonly note?: string | undefined;
  /** Accepted items to keep in the project's knowledge base, e.g. `O1` (REQ-PLAN-11/AC8). */
  readonly keep?: string | undefined;
  /** The person deciding. */
  readonly user?: string | undefined;
}

/** One session of the run with its items and the decisions that still count. */
export interface ReviewedSession {
  readonly id: string;
  readonly session: ExploreSession | CliExploreSession;
  readonly sha256: string;
  readonly items: readonly ReviewItem[];
  readonly review: ReviewRecord | undefined;
  readonly accepted: readonly string[];
  /** Decisions made on an earlier version of the session file; they no longer count. */
  readonly stale: number;
}

/**
 * The exploratory sessions of a run with the items a person reviews and the decisions that still count
 * (REQ-PLAN-11/AC1+AC2). Used by `qj explore review` and by `qj plan`.
 *
 * @param session - The open run.
 * @param only - One session id, or every session of the run.
 */
export async function reviewedSessions(session: RunSession, only?: string): Promise<ReviewedSession[]> {
  const ids = only
    ? [only]
    : (await readdir(session.ws.path("explore")).catch(() => [] as string[]))
        .filter((d) => /^S\d{2,3}$/.test(d))
        .sort();
  const out: ReviewedSession[] = [];
  for (const id of ids) {
    const text = await readFile(session.ws.path("explore", id, "session.json"), "utf8").catch(
      () => undefined,
    );
    if (text === undefined) {
      if (only)
        throw new ConfigError("EXPLORE_SESSION_NOT_FOUND", `No exploratory session ${id} in this run.`, {});
      continue;
    }
    const raw = JSON.parse(text) as { kind?: unknown };
    const parsed = raw.kind === "cli" ? CliExploreSessionSchema.parse(raw) : ExploreSessionSchema.parse(raw);
    const sha256 = createHash("sha256").update(text).digest("hex");
    const reviewText = await readFile(session.ws.path("explore", id, "review.json"), "utf8").catch(
      () => undefined,
    );
    const review = reviewText === undefined ? undefined : ReviewRecordSchema.parse(JSON.parse(reviewText));
    out.push({
      id,
      session: parsed,
      sha256,
      items: reviewItems(parsed),
      review,
      accepted: acceptedItems(review, sha256),
      stale: review && review.sessionSha256 !== sha256 ? review.decisions.length : 0,
    });
  }
  return out;
}

const list = (s: ReviewedSession): string => {
  const latest = new Map<string, "accepted" | "rejected">();
  if (s.stale === 0) for (const d of s.review?.decisions ?? []) latest.set(d.item, d.decision);
  const state = (id: string): string => latest.get(id) ?? "not reviewed";
  const counts = (st: string): number => s.items.filter((i) => state(i.id) === st).length;
  return [
    ...(s.stale > 0
      ? [
          `${s.id}: the session changed after ${String(s.stale)} decision(s); they no longer count, review it again`,
        ]
      : []),
    `${s.id}: ${String(s.items.length)} item(s): ${String(counts("accepted"))} accepted, ${String(counts("rejected"))} rejected, ${String(counts("not reviewed"))} not reviewed · report: explore/${s.id}/report.html`,
    ...s.items.map(
      (i) =>
        `  ${i.id} [${state(i.id)}] ${i.kind}: ${i.title}${i.detail ? ` — ${i.detail}` : ""}${i.actions.length > 0 ? ` (${i.actions.join(", ")})` : ""}`,
    ),
  ].join("\n");
};

const ids = (raw: string | undefined): string[] =>
  (raw ?? "")
    .split(",")
    .map((s) => s.trim().toUpperCase())
    .filter(Boolean);

/**
 * `qajitsu explore review <TICKET> [--session S01] [--accept O1,C2] [--reject F1] [--note ...]`: a person accepts or
 * rejects what exploratory sessions found before the plan is written (REQ-PLAN-11/AC1+AC2). Without flags it lists
 * the items and, in a terminal, asks for each one not reviewed yet; nothing is accepted by default. Decisions are kept
 * in `explore/<session>/review.json` with the SHA-256 of the session file and journaled with the person.
 *
 * @returns 0, or 3 on errors.
 */
export async function runExploreReview(
  rawKey: string,
  options: ExploreReviewOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & KnowledgePorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const accept = ids(options.accept);
    const keep = ids(options.keep);
    const reject = ids(options.reject);
    if ((accept.length > 0 || reject.length > 0 || keep.length > 0) && options.session === undefined)
      throw new ConfigError(
        "OPTION_INVALID",
        "--accept, --reject and --keep need --session: item ids are per session (e.g. --session S01 --accept O1).",
        {},
      );
    const both = accept.filter((a) => reject.includes(a));
    if (both.length > 0)
      throw new ConfigError("OPTION_INVALID", `${both.join(", ")} cannot be both accepted and rejected.`, {});
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const sessions = await reviewedSessions(session, options.session);
    if (sessions.length === 0) {
      io.write(
        `No exploratory session in run ${session.ws.runId}; start one with 'qajitsu explore ${rawKey}'.\n`,
      );
      return 0;
    }
    const by = options.user ?? "unknown";
    for (const s of sessions) {
      let decisions = [
        ...accept.map((item) => ({ item, decision: "accepted" as const, note: options.note })),
        ...reject.map((item) => ({ item, decision: "rejected" as const, note: options.note })),
      ];
      // In a terminal, a person decides on each item not reviewed yet; without one, nothing is decided.
      if (decisions.length === 0 && io.ask) {
        io.write(`${list(s)}\n`);
        const open = s.items.filter(
          (i) =>
            !s.accepted.includes(i.id) && !s.review?.decisions.some((d) => d.item === i.id && s.stale === 0),
        );
        for (const item of open) {
          const answer = (await io.ask(`${s.id} ${item.id} ${item.title}: [a]ccept, [r]eject, [s]kip? `))
            .trim()
            .toLowerCase();
          if (answer.startsWith("a"))
            decisions = [...decisions, { item: item.id, decision: "accepted", note: undefined }];
          if (answer.startsWith("r"))
            decisions = [...decisions, { item: item.id, decision: "rejected", note: undefined }];
        }
      }
      if (decisions.length === 0) {
        io.write(`${list(s)}\n`);
        continue;
      }
      const record = recordDecisions(s.review, {
        session: s.id,
        sessionSha256: s.sha256,
        items: s.items,
        decisions: decisions.map((d) => ({ ...d, note: d.note ? masker.maskText(d.note) : undefined })),
        by,
        at: ports.now().toISOString(),
      });
      await writeFile(
        session.ws.path("explore", s.id, "review.json"),
        `${JSON.stringify(record, null, 2)}\n`,
      );
      session.events.emit("explore", { kind: "user", name: by }, "explore.reviewed", {
        session: s.id,
        sessionSha256: s.sha256,
        decisions: decisions.map((d) => ({ item: d.item, decision: d.decision })),
      });
      const [updated] = await reviewedSessions(session, s.id);
      if (updated) io.write(`${list(updated)}\n`);
    }
    if (keep.length > 0) await keepInKnowledge(session, sessions[0]?.id ?? "", keep, by, io, ports);
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}

/**
 * What `qj plan` shows about exploration (REQ-PLAN-11/AC3+AC6+AC7): how many accepted items the planner was offered,
 * the cases that come from each, and the items no case covers with the open question that keeps them visible.
 *
 * @param plan - The plan version shown.
 * @param session - The open run.
 * @returns Lines to print; none when no item was accepted.
 */
export async function explorationLines(plan: Plan, session: RunSession): Promise<string[]> {
  const sessions = (await reviewedSessions(session)).filter((s) => s.accepted.length > 0);
  if (sessions.length === 0) return [];
  const offered = sessions.reduce((n, s) => n + s.accepted.length, 0);
  const lines = [
    `Exploration: ${String(offered)} accepted item(s) offered to the planner (${sessions.map((s) => `${s.id}: ${s.accepted.join(", ")}`).join("; ")})`,
  ];
  for (const s of sessions)
    for (const id of s.accepted) {
      const ref = `${s.id}/${id}`;
      const cases = plan.cases
        .filter((c) => c.source.some((x) => x.kind === "explore" && x.session === s.id && x.item === id))
        .map((c) => c.id);
      const question = plan.open_questions.find((q) => q.question.includes(ref));
      lines.push(
        cases.length > 0
          ? `  ${ref} → ${cases.join(", ")}`
          : `  ${ref} → no case${question ? `: open question ${question.id}` : ""}`,
      );
    }
  return lines;
}

/**
 * Keeps accepted observations and findings in the project's knowledge base (REQ-PLAN-11/AC8): one Markdown note per
 * item in the project's `explore-notes/` folder, registered as a knowledge source tagged `exploration`, so planners of
 * later tickets find it with `search_docs` and cite it like any document. Only accepted items can be kept.
 */
async function keepInKnowledge(
  session: RunSession,
  sessionId: string,
  keep: readonly string[],
  by: string,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & KnowledgePorts,
): Promise<void> {
  const [current] = await reviewedSessions(session, sessionId);
  if (!current) return;
  const notAccepted = keep.filter((id) => !current.accepted.includes(id));
  if (notAccepted.length > 0)
    throw new ConfigError(
      "EXPLORE_KEEP_NOT_ACCEPTED",
      `${notAccepted.join(", ")} is not accepted: only accepted items can be kept (add --accept ${notAccepted.join(",")})`,
      {},
    );
  const notes = keep.filter((id) => !id.startsWith("C"));
  if (notes.length < keep.length)
    throw new ConfigError(
      "OPTION_INVALID",
      "--keep takes observations and findings (O1, F1), not checklist items.",
      {},
    );
  const home = session.project.project?.paths.home;
  if (home === undefined)
    throw new ConfigError("PROJECT_NOT_SELECTED", "Keeping a note needs a registered project.", {});
  const dir = join(home, "explore-notes");
  await mkdir(dir, { recursive: true });
  const ticket = session.ws.ticket;
  for (const id of notes) {
    const item = current.items.find((i) => i.id === id);
    if (!item) continue;
    const decided = current.review?.decisions.filter((d) => d.item === id).at(-1);
    await writeFile(
      join(dir, `${ticket}-${sessionId}-${id}.md`),
      [
        `# ${item.title}`,
        "",
        `Ticket: ${ticket} · run ${session.ws.runId} · exploratory session ${sessionId}, item ${id} (${item.kind})`,
        `Accepted by ${decided?.by ?? by} on ${decided?.at ?? ""}`,
        "",
        item.detail || "(no detail)",
        "",
        "Known behaviour seen in exploration; it says what is worth testing, not what the result must be.",
        "",
      ].join("\n"),
    );
    session.events.emit("explore", { kind: "user", name: by }, "explore.kept", {
      session: sessionId,
      item: id,
    });
  }
  const code = await runKnowledgeAdd([dir], { tag: ["exploration"] }, io, ports);
  if (code !== 0)
    throw new ConfigError("KNOWLEDGE_ADD_FAILED", "The note could not be added to the knowledge base.", {});
  io.write(`Kept in the knowledge base: ${notes.map((id) => `${sessionId}/${id}`).join(", ")} (${dir})\n`);
}
