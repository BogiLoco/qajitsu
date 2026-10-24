import { appendFile, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createFileWorkflow, createJiraWorkflow } from "@qajitsu/adapter-publish-jira";
import {
  admitRun,
  moveTicket,
  processAlive,
  readHolder,
  readRunIndex,
  type RunIndex,
  type TicketKey,
  type ProjectConfig,
  type Publisher,
  type TestStatus,
  type TicketWorkflow,
} from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import type { LoadedProject } from "../project.js";
import type { RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** The roles of the team's statuses (REQ-FLOW-02/AC1). */
export type StatusRole = keyof NonNullable<ProjectConfig["workflow"]>["statuses"];

/** The tracker's workflow of a project, or nothing when the project maps no statuses (QAJitsu then moves nothing). */
export function workflowFor(
  project: LoadedProject,
  deps: Pick<RuntimePorts, "fetch" | "now"> & {
    readonly logger: RunSession["logger"];
    readonly resolveSecret: (ref: string) => Promise<string>;
    readonly registerSecret: (value: string) => void;
  },
): TicketWorkflow | undefined {
  const flow = project.config.workflow;
  if (!flow) return undefined;
  const jira = project.config.jira;
  if (jira.type === "file")
    return createFileWorkflow(
      resolve(project.qaDir, jira.tickets_dir ?? "tickets"),
      Object.values(flow.statuses).filter((s): s is string => s !== undefined),
    );
  return createJiraWorkflow(
    { flavor: jira.type, baseUrl: jira.base_url ?? "", email: jira.email, token: jira.token ?? "" },
    {
      fetch: deps.fetch,
      logger: deps.logger,
      now: deps.now,
      resolveSecret: deps.resolveSecret,
      registerSecret: deps.registerSecret,
    },
  );
}

/** The workflow of a run's project, with the run's secret handling. */
export function runWorkflow(session: RunSession, ports: RuntimePorts): TicketWorkflow | undefined {
  return workflowFor(session.project, {
    fetch: ports.fetch,
    now: ports.now,
    logger: session.logger,
    resolveSecret: session.resolveSecret,
    registerSecret: (v) => {
      session.masker.register(v);
    },
  });
}

/**
 * Moves the run's ticket to the status of a role (REQ-FLOW-02/AC3): when the workflow offers no transition there, or
 * the tracker fails, the ticket stays where it is, a comment says why, and the journal keeps it; the run's result is
 * never lost over the ticket's status.
 *
 * @returns Whether the ticket is now in that status.
 */
export async function moveToRole(
  session: RunSession,
  io: CommandIO,
  workflow: TicketWorkflow,
  publisher: Publisher,
  role: StatusRole,
  why: string,
): Promise<boolean> {
  const { ws, events, masker, project } = session;
  const to = project.config.workflow?.statuses[role];
  if (to === undefined) return false;
  const system = { kind: "system", name: "orchestrator" } as const;
  let outcome: { moved: boolean; from?: string; reason?: string };
  try {
    outcome = await moveTicket(workflow, ws.ticket, to);
  } catch (error) {
    outcome = {
      moved: false,
      reason: masker.maskText(error instanceof Error ? error.message : String(error)),
    };
  }
  events.emit("publish", system, "ticket.transition", { role, to, why, ...outcome });
  if (outcome.moved) {
    io.write(`Moved ${ws.ticket} to "${to}" (${why}).\n`);
    return true;
  }
  io.writeError(`Warning: ${ws.ticket} stays where it is: ${outcome.reason ?? "unknown reason"}.\n`);
  const text = `QAJitsu could not move ${ws.ticket} to "${to}" (${why}): ${outcome.reason ?? "unknown reason"}. The run's result stays in its comment.`;
  try {
    await publisher.publish({
      ticket: ws.ticket,
      runId: ws.runId,
      name: "transition",
      comment: {
        adf: {
          type: "doc",
          version: 1,
          content: [{ type: "paragraph", content: [{ type: "text", text: masker.maskText(text) }] }],
        },
        wiki: masker.maskText(text),
      },
      attachments: [],
    });
  } catch {
    // The warning above and the journal already say it.
  }
  return false;
}

/** The change's author on the code host, from the changes found at fetch (REQ-FLOW-04/AC2). */
async function changeAuthor(session: Pick<RunSession, "ws">): Promise<string | undefined> {
  try {
    const found = JSON.parse(await readFile(session.ws.path("repos", "changes.json"), "utf8")) as {
      changes?: { change?: { author?: unknown } }[];
    };
    for (const c of found.changes ?? []) if (typeof c.change?.author === "string") return c.change.author;
  } catch {
    // No record of the changes: no author.
  }
  return undefined;
}

/** Where a ticket goes after its run (REQ-FLOW-04): decided by code from the computed statuses only. */
export function verdictTarget(
  statuses: readonly TestStatus[],
  passedToDone: boolean,
): { role: StatusRole; why: string } {
  if (statuses.length === 0) return { role: "needs_review", why: "no case ran" };
  if (statuses.includes("FAILED")) return { role: "failed", why: "a case FAILED" };
  if (statuses.every((s) => s === "PASSED"))
    return passedToDone
      ? { role: "done", why: "every case PASSED" }
      : { role: "passed", why: "every case PASSED" };
  return { role: "in_testing", why: "a case needs a person (BLOCKED, NEEDS_REVIEW, FLAKY or NOT_RUN)" };
}

/**
 * Applies the transition policy after the results comment is published (REQ-FLOW-04): every case PASSED moves the
 * ticket to "passed" (to "done" only with `passed_to_done`); a FAILED case sends it back to development, assigned to
 * the change's author when the project maps their account; anything that needs a person keeps it in testing with a
 * label, assigned to the QA person. Only computed statuses decide; no agent can trigger it.
 *
 * @returns The role the ticket was sent to, when the project maps statuses.
 */
export async function applyVerdictPolicy(
  session: RunSession,
  io: CommandIO,
  workflow: TicketWorkflow,
  publisher: Publisher,
  statuses: readonly TestStatus[],
): Promise<StatusRole | undefined> {
  const flow = session.project.config.workflow;
  if (!flow) return undefined;
  const target = verdictTarget(statuses, flow.passed_to_done && flow.statuses.done !== undefined);
  if (target.role === "done") await moveToRole(session, io, workflow, publisher, "passed", target.why);
  const moved = await moveToRole(session, io, workflow, publisher, target.role, target.why);
  const { ws } = session;
  try {
    if (target.role === "failed") {
      const author = await changeAuthor(session);
      const account = author === undefined ? undefined : flow.authors[author];
      if (account !== undefined) {
        await workflow.assign(ws.ticket, account);
        io.write(`Assigned ${ws.ticket} to ${author ?? ""}, the change's author.\n`);
      }
    }
    if (target.role === "in_testing") {
      await workflow.addLabel(ws.ticket, flow.attention_label);
      if (flow.qa_assignee !== undefined) await workflow.assign(ws.ticket, flow.qa_assignee);
    }
  } catch (error) {
    io.writeError(
      `Warning: ${ws.ticket} was not assigned or labelled: ${session.masker.maskText(error instanceof Error ? error.message : String(error))}\n`,
    );
  }
  return moved ? target.role : undefined;
}

/** Doctor checks of the workflow mapping (REQ-FLOW-02/AC2): every mapped status exists and the account may move tickets. */
export async function workflowChecks(
  project: LoadedProject,
  workflow: TicketWorkflow,
): Promise<{ name: string; ok: boolean; detail: string }[]> {
  const flow = project.config.workflow;
  if (!flow) return [];
  const key = project.config.jira.project_key;
  try {
    const known = (await workflow.projectStatuses(key)).map((s) => s.toLowerCase());
    const missing = Object.entries(flow.statuses).filter(
      ([, name]) => name !== undefined && !known.includes(name.toLowerCase()),
    );
    const allowed = await workflow.canTransition(key);
    return [
      {
        name: "workflow",
        ok: missing.length === 0 && allowed,
        detail:
          missing.length === 0 && allowed
            ? `statuses of ${key} mapped, transitions allowed`
            : [
                ...missing.map(([role, name]) => `${role} "${name ?? ""}" is not a status of ${key}`),
                ...(allowed ? [] : ["the account may not transition issues (TRANSITION_ISSUES)"]),
              ].join("; "),
      },
    ];
  } catch (error) {
    return [{ name: "workflow", ok: false, detail: error instanceof Error ? error.message : String(error) }];
  }
}

/**
 * Admission of a new run in the team's workflow (REQ-FLOW-05/AC1+AC2), checked before `qj fetch` creates it: while
 * another run of the ticket is active (a live process holds its lock) the new event is ignored and logged in
 * `<ticket>/flow.jsonl`; after `max_runs_per_day` runs a day the ticket goes to human review instead of another run.
 * Without `workflow` in the project, parallel runs of a ticket stay allowed (REQ-WS-04/AC2).
 *
 * @returns The exit code when the run must not start, otherwise undefined.
 */
export async function admitNewRun(
  project: LoadedProject,
  root: string,
  ticket: TicketKey,
  io: CommandIO,
  deps: {
    readonly now: () => Date;
    /** Opens a finished run of the ticket, to move it and comment on it. */
    readonly openRun: (
      runId: string,
    ) => Promise<{ session: RunSession; workflow?: TicketWorkflow; publisher: Publisher }>;
  },
): Promise<number | undefined> {
  const flow = project.config.workflow;
  if (!flow) return undefined;
  const index = await readRunIndex(root, ticket).catch(() => ({ runs: [] as RunIndex["runs"] }));
  const runs = await Promise.all(
    index.runs.map(async (r) => {
      const pid = await readHolder(join(root, ticket, r.runId, "run.lock"));
      return { runId: r.runId, createdAt: r.createdAt, active: pid !== undefined && processAlive(pid) };
    }),
  );
  const decision = admitRun(runs, deps.now(), flow.max_runs_per_day);
  if (decision.admit) return undefined;
  await appendFile(
    join(root, ticket, "flow.jsonl"),
    `${JSON.stringify({ ts: deps.now().toISOString(), event: "run.not_started", ...decision })}\n`,
  );
  if (decision.reason === "active") {
    io.write(`Run ${decision.runId} of ${ticket} is still active; this event is ignored.\n`);
    return 0;
  }
  io.writeError(
    `${ticket} had ${String(decision.today)} runs today (limit ${String(decision.limit)}): no new run; it needs a person.\n`,
  );
  const latest = index.runs.at(-1);
  if (latest) {
    const { session, workflow, publisher } = await deps.openRun(latest.runId);
    session.events.emit("fetch", { kind: "system", name: "orchestrator" }, "run.daily_limit", {
      today: decision.today,
      limit: decision.limit,
    });
    if (workflow)
      await moveToRole(
        session,
        io,
        workflow,
        publisher,
        "needs_review",
        `${String(decision.today)} runs today`,
      );
  }
  return 2;
}
