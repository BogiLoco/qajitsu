import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  AgentOutputError,
  TokenBudgetExceededError,
  buildChangeContext,
  createUsageTracker,
  loadKnowledge,
  runAnalyst,
  runPlanner,
  sourceContext,
  type AgentStageDeps,
} from "@qajitsu/agents";
import {
  AnalysisSchema,
  ConfigError,
  PlanDraftSchema,
  QajitsuError,
  approvePlan,
  diffPlans,
  formatPlanDiff,
  parsePlan,
  readPlan,
  writePlanVersion,
  type Analysis,
  type Plan,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { exportRunTelemetry } from "./telemetry.js";
import { anchorJournal } from "./verdict.js";
import { checkPlanSources, formatSourceIssues } from "@qajitsu/verifier";
import { parse } from "yaml";
import type { RuntimePorts } from "../adapters.js";
import { knowledgeDir, openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** Options of `qajitsu plan`. */
export interface PlanOptions {
  readonly run?: string | undefined;
  readonly revise?: string | undefined;
}

/** Ports of the review loop (REQ-PLAN-04/AC1). */
export interface ReviewPorts {
  /** Opens a file in the user's editor and resolves when it is closed. */
  readonly openEditor?: ((file: string) => Promise<void>) | undefined;
  /** Name recorded as approver. */
  readonly user: string;
}

const formatError = (error: unknown, mask: (t: string) => string): string => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  const ctx = error instanceof QajitsuError ? error.context : {};
  const list = (
    Array.isArray(ctx["issues"]) ? ctx["issues"] : Array.isArray(ctx["errors"]) ? ctx["errors"] : []
  ) as unknown[];
  return mask(
    `Error${code}: ${error instanceof Error ? error.message : String(error)}\n${list.map((i) => `  - ${String(i)}\n`).join("")}`,
  );
};

/**
 * Exit code for a failure: BLOCKED (2) when the token budget stopped the run (REQ-LLM-07/AC2),
 * otherwise a configuration/framework error (3).
 */
const exitFor = (error: unknown): number => (error instanceof TokenBudgetExceededError ? 2 : 3);

function stageDeps(session: RunSession, ports: RuntimePorts): AgentStageDeps & { save: () => Promise<void> } {
  const used = Number(session.ws.record.data["tokens"] ?? 0);
  const usage = createUsageTracker({
    events: session.events,
    budget: session.project.config.models.token_budget,
    alreadyUsed: used,
  });
  return {
    ws: session.ws,
    models: session.models,
    events: session.events,
    usage,
    now: ports.now,
    maskJson: (v) => session.masker.maskJson(v),
    maskText: (t) => session.masker.maskText(t),
    save: async () => {
      await session.ws.update({
        data: { ...session.ws.record.data, tokens: usage.total, costUsd: Number(usage.costUsd.toFixed(6)) },
      });
    },
  };
}

/**
 * Validates a manually edited plan file and stores it as a new version (REQ-PLAN-04/AC3).
 *
 * @returns The new plan, or the problems found.
 */
async function acceptEditedPlan(
  session: RunSession,
  file: string,
): Promise<{ plan?: Plan; problems: string[] }> {
  let draft;
  try {
    const raw = parse(await readFile(file, "utf8")) as Record<string, unknown>;
    draft = PlanDraftSchema.parse({
      summary: raw["summary"],
      cases: raw["cases"],
      open_questions: raw["open_questions"],
      out_of_scope: raw["out_of_scope"],
    });
    const candidate = parsePlan({ schema: 1, ticket: session.ws.ticket, version: 1, ...draft });
    const issues = checkPlanSources(candidate, sourceContext(await buildChangeContext(session.ws)));
    if (issues.length > 0) return { problems: formatSourceIssues(issues).split("\n") };
  } catch (error) {
    const issues =
      error instanceof QajitsuError && Array.isArray(error.context["issues"])
        ? (error.context["issues"] as string[])
        : [];
    return {
      problems:
        issues.length > 0
          ? issues
          : [error instanceof Error ? (error.message.split("\n")[0] ?? "invalid plan") : String(error)],
    };
  }
  return { plan: await writePlanVersion(session.ws, draft), problems: [] };
}

/**
 * `qajitsu plan <TICKET>`: analyst + planner write `plan.vN.yaml`/`.md`; in a terminal the user then
 * accepts, revises, edits or quits (REQ-PLAN-01..05, REQ-PLAN-04).
 *
 * @returns Exit code: 0 plan written (or approved), 2 token budget exceeded, 3 errors.
 */
export async function runPlan(
  rawKey: string,
  options: PlanOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  review: ReviewPorts,
): Promise<number> {
  const masker = createMasker();
  let session: RunSession | undefined;
  try {
    session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const ws = session.ws;
    if (!ws.record.checkpoints.some((c) => c.stage === "fetch")) {
      throw new ConfigError(
        "RUN_NOT_FETCHED",
        `Run ${ws.runId} has no fetched context; run 'qajitsu fetch' first.`,
        {},
      );
    }
    if (ws.record.data["approval"] !== undefined) {
      throw new ConfigError(
        "PLAN_ALREADY_APPROVED",
        "The plan of this run is approved and frozen; start a new run to plan again.",
        {},
      );
    }
    const deps = stageDeps(session, ports);
    const knowledge = await loadKnowledge(knowledgeDir(session.project), (t) => masker.containsSecret(t));
    const context = await buildChangeContext(ws, knowledge);
    let analysis: Analysis;
    try {
      analysis = AnalysisSchema.parse(JSON.parse(await readFile(ws.path("analysis.json"), "utf8")));
    } catch {
      io.write("Analysing the change…\n");
      analysis = await runAnalyst(deps, context);
      await deps.save();
    }

    let current: Plan | undefined;
    try {
      current = (await readPlan(ws)).plan;
    } catch {
      current = undefined;
    }
    let instruction = options.revise;
    if (current && instruction === undefined && !io.ask) {
      io.write(
        `Plan v${String(current.version)} exists: ${ws.path("plan", `plan.v${String(current.version)}.md`)}\n`,
      );
      return 0;
    }
    for (;;) {
      if (!current || instruction !== undefined) {
        io.write(current ? `Revising plan v${String(current.version)}…\n` : "Writing the test plan…\n");
        const draft = await runPlanner(
          deps,
          context,
          analysis,
          current && instruction !== undefined ? { previous: current, instruction } : undefined,
        );
        await deps.save();
        const next = await writePlanVersion(ws, draft);
        session.events.emit("plan", { kind: "agent", name: "planner" }, "plan.version", {
          version: next.version,
          cases: next.cases.length,
        });
        if (current)
          io.write(
            `Changes v${String(current.version)} → v${String(next.version)}:\n${formatPlanDiff(diffPlans(current, next))}\n`,
          );
        current = next;
        instruction = undefined;
      }
      const mdFile = ws.path("plan", `plan.v${String(current.version)}.md`);
      io.write(
        `Plan v${String(current.version)}: ${String(current.cases.length)} case(s), ${String(current.open_questions.length)} open question(s)\n${mdFile}\n`,
      );
      for (const q of current.open_questions) io.write(`  ? ${q.id}: ${q.question}\n`);
      if (!io.ask) return 0;

      const answer = (await io.ask("[a]ccept, [r]evise, [e]dit, [q]uit? ")).trim().toLowerCase();
      if (answer === "a" || answer === "accept") {
        let confirm = false;
        if (current.open_questions.length > 0) {
          confirm =
            (
              await io.ask(
                `Approve with ${String(current.open_questions.length)} open question(s)? Type 'yes' to confirm: `,
              )
            ).trim() === "yes";
          if (!confirm) continue;
        }
        const issues = checkPlanSources(current, sourceContext(context));
        if (issues.length > 0) {
          io.write(
            `The plan has ungrounded sources and cannot be approved:\n${formatSourceIssues(issues)}\n`,
          );
          continue;
        }
        // Approve exactly the version the user reviewed, never whatever is newest on disk.
        const approval = await approvePlan(ws, {
          approver: review.user,
          now: ports.now,
          version: current.version,
          confirmOpenQuestions: confirm,
        });
        session.events.emit("approve", { kind: "user", name: review.user }, "plan.approved", { ...approval });
        io.write(`Approved plan v${String(approval.version)} (sha256 ${approval.sha256.slice(0, 16)}…)\n`);
        return 0;
      }
      if (answer === "r" || answer === "revise") {
        instruction = (await io.ask("What should change? ")).trim();
        session.events.emit("plan", { kind: "user", name: review.user }, "plan.revision_requested", {
          instruction,
        });
        if (instruction === "") instruction = undefined;
        continue;
      }
      if ((answer === "e" || answer === "edit") && review.openEditor) {
        const draftFile = ws.path("plan", "plan.edit.yaml");
        await copyFile(ws.path("plan", `plan.v${String(current.version)}.yaml`), draftFile);
        await review.openEditor(draftFile);
        const { plan, problems } = await acceptEditedPlan(session, draftFile);
        if (!plan) {
          io.write(`The edited plan was rejected:\n${problems.map((p) => `  - ${p}`).join("\n")}\n`);
          continue;
        }
        session.events.emit("plan", { kind: "user", name: review.user }, "plan.edited", {
          version: plan.version,
        });
        io.write(
          `Changes v${String(current.version)} → v${String(plan.version)}:\n${formatPlanDiff(diffPlans(current, plan))}\n`,
        );
        current = plan;
        continue;
      }
      if (answer === "q" || answer === "quit") return 0;
    }
  } catch (error) {
    if (error instanceof AgentOutputError)
      io.writeError("The model did not produce a valid result; nothing was guessed.\n");
    if (error instanceof TokenBudgetExceededError && session) {
      await session.ws.update({
        status: "failed",
        data: { ...session.ws.record.data, blocked: { reason: "TOKEN_BUDGET_EXCEEDED" } },
      });
    }
    io.writeError(formatError(error, (t) => masker.maskText(t)));
    return exitFor(error);
  }
}

/** Options of `qajitsu approve`. */
export interface ApproveOptions {
  readonly run?: string | undefined;
  readonly version?: string | undefined;
  readonly confirmOpenQuestions?: boolean | undefined;
}

/**
 * `qajitsu approve <TICKET>`: freezes a plan version without the interactive loop, e.g. in CI
 * (REQ-PLAN-06, REQ-PLAN-05/AC2). The version is re-validated and its sources re-checked first.
 */
export async function runApprove(
  rawKey: string,
  options: ApproveOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  review: ReviewPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const version = options.version === undefined ? undefined : Number(options.version);
    const { plan } = await readPlan(session.ws, version);
    const issues = checkPlanSources(plan, sourceContext(await buildChangeContext(session.ws)));
    if (issues.length > 0) {
      throw new ConfigError("PLAN_SOURCES_INVALID", "The plan has ungrounded sources.", {
        issues: formatSourceIssues(issues).split("\n"),
      });
    }
    const approval = await approvePlan(session.ws, {
      approver: review.user,
      now: ports.now,
      ...(version === undefined ? {} : { version }),
      confirmOpenQuestions: options.confirmOpenQuestions === true,
    });
    session.events.emit("approve", { kind: "user", name: review.user }, "plan.approved", { ...approval });
    io.write(
      `Approved plan v${String(approval.version)} of ${session.ws.ticket} run ${session.ws.runId}\nsha256 ${approval.sha256}\n${join(session.ws.dir, "plan", "plan.approved.yaml")}\n`,
    );
    // REQ-OBS-03: export what this command added to the journal; telemetry never changes the result.
    await anchorJournal(session);
    const telemetry = await exportRunTelemetry(session, ports.fetch);
    if (telemetry?.error !== undefined) io.writeError(`Telemetry export failed: ${telemetry.error}\n`);
    return 0;
  } catch (error) {
    io.writeError(formatError(error, (t) => masker.maskText(t)));
    return 3;
  }
}
