import { runPlanApprover, type AgentStageDeps, type ChangeContext } from "@qajitsu/agents";
import { sha256, type ApprovalStep, type Plan, type Publisher } from "@qajitsu/core";
import type { RunSession } from "../session.js";
import { publishPlanComment } from "./ci.js";
import type { CommandIO } from "./fetch.js";

/** Outcome of the steps of an approval flow before the plan is frozen. */
export type FlowOutcome =
  | { readonly approve: true; readonly approver: string; readonly modelOnly: boolean }
  | { readonly approve: false; readonly exitCode: number };

/** Appends one step to `run.json` (`approvals`) and to the journal (REQ-PLAN-10/AC3). */
export async function recordApprovalStep(session: RunSession, step: ApprovalStep): Promise<number> {
  const previous = (session.ws.record.data["approvals"] as ApprovalStep[] | undefined) ?? [];
  await session.ws.update({ data: { ...session.ws.record.data, approvals: [...previous, step] } });
  session.events.emit(
    "approve",
    {
      kind: step.kind === "person" ? "user" : step.kind === "model" ? "agent" : "system",
      name: step.identity,
    },
    "approval.step",
    { ...step },
  );
  return previous.length + 1;
}

/** The comment of one decision: who decided what on which plan version, with the hashes (REQ-PLAN-10/AC4). */
const stepComment = (
  session: RunSession,
  step: ApprovalStep,
  position: string,
): { title: string; lines: string[] } => ({
  title: `QAJitsu plan approval for ${session.ws.ticket} (run ${session.ws.runId}), ${position}: ${
    step.kind === "code" ? "code" : `${step.kind} ${step.identity}`
  } decided ${step.decision}`,
  lines: [
    ...step.reasons.map((r) => `Reason: ${r}`),
    `Plan v${String(step.version)} sha256 ${step.planSha256}`,
    ...(step.promptSha256 ? [`Prompt sha256 ${step.promptSha256}`] : []),
    ...(step.answerSha256 ? [`Answer sha256 ${step.answerSha256}`] : []),
    `At ${step.at}`,
  ],
});

/** Posts one comment of the approval flow to the ticket (REQ-PLAN-10/AC4). */
export type ApprovalCommenter = (name: string, title: string, lines: readonly string[]) => Promise<void>;

/**
 * With `approval.jira: comment`, the plan and every decision of the approval flow are posted to the ticket: the plan
 * as one comment updated per version, each decision and the freeze as comments of their own, with the hashes
 * (REQ-PLAN-10/AC4). Jira mirrors the records in `run.json` and the journal: a comment that fails is reported and
 * journaled, and never changes a decision.
 *
 * @returns Nothing when the project does not comment on approvals.
 */
export async function approvalCommenter(
  session: RunSession,
  io: CommandIO,
  publisher: Publisher,
): Promise<ApprovalCommenter | undefined> {
  if (session.project.config.approval.jira !== "comment") return undefined;
  const { masker, ws, events } = session;
  const failed = (name: string, error: unknown): void => {
    const message = masker.maskText(error instanceof Error ? error.message : String(error));
    io.writeError(`Warning: the approval comment ${name} was not posted to ${ws.ticket}: ${message}\n`);
    events.emit("approve", { kind: "system", name: "jira" }, "approval.comment_failed", {
      name,
      error: message,
    });
  };
  try {
    const plan = await publishPlanComment(session, publisher);
    io.write(
      `${plan.updated ? "Updated" : "Posted"} the plan on ${ws.ticket}${plan.url ? `: ${plan.url}` : ""}\n`,
    );
  } catch (error) {
    failed("plan", error);
  }
  return async (name, title, lines) => {
    const masked = lines.map((l) => masker.maskText(l));
    const text = masked.join("\n");
    const heading = masker.maskText(title);
    try {
      const result = await publisher.publish({
        ticket: ws.ticket,
        runId: ws.runId,
        name,
        comment: {
          adf: {
            type: "doc",
            version: 1,
            content: [
              { type: "paragraph", content: [{ type: "text", text: heading, marks: [{ type: "strong" }] }] },
              ...masked.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
            ],
          },
          wiki: `*${heading}*\n{noformat}\n${text.replace(/\{noformat\}/gi, "{ noformat }")}\n{noformat}`,
        },
        attachments: [],
      });
      events.emit("approve", { kind: "system", name: "jira" }, "approval.commented", {
        name,
        commentId: result.commentId,
      });
    } catch (error) {
      failed(name, error);
    }
  };
}

const describe = (step: ApprovalStep): string => {
  const [first, ...more] = step.reasons;
  return `${step.kind === "code" ? "code" : `${step.kind} ${step.identity}`}): ${step.decision}${
    first === undefined ? "" : ` — ${first}`
  }${more.map((r) => `\n    - ${r}`).join("")}`;
};

/**
 * Runs the model steps of the project's approval flow in order (REQ-PLAN-10, ADR-0010). A model step can approve,
 * ask for a revision (the flow stops) or hand over to a person (the next person step decides, or the flow stops and
 * says how a person approves). Person steps approve as the current user. With `person` set, a person decides at
 * once in place of the flow. Every step is recorded with the SHA-256 of the plan version it decided on.
 *
 * @returns Whether to freeze the plan, and as whom; or the exit code to stop with.
 */
export async function runApprovalFlow(
  session: RunSession,
  io: CommandIO,
  input: {
    readonly deps: AgentStageDeps & { readonly save: () => Promise<void> };
    readonly plan: Plan;
    readonly planText: string;
    readonly context: ChangeContext;
    readonly flags: readonly string[];
    /** What no case covers (REQ-PLAN-14), one line each. */
    readonly gaps?: readonly string[];
    readonly person: string;
    readonly asPerson: boolean;
    /** Throws when a person may not approve yet (unconfirmed flags or open questions). */
    readonly checkPerson: () => void;
    /** Posts each decision to the ticket (`approval.jira: comment`). */
    readonly comment?: ApprovalCommenter | undefined;
    readonly now: () => Date;
  },
): Promise<FlowOutcome> {
  const { approval } = session.project.config;
  const steps = input.asPerson ? (["person"] as const) : approval.flow;
  const verbose = steps.length > 1 || steps[0] !== "person";
  const planSha256 = sha256(input.planText);
  const base = { version: input.plan.version, planSha256 };
  let models: string | undefined;
  const record = async (step: ApprovalStep, position: string): Promise<void> => {
    const n = await recordApprovalStep(session, step);
    const { title, lines } = stepComment(session, step, position);
    await input.comment?.(`approval-${String(n)}`, title, lines);
  };
  for (const [i, kind] of steps.entries()) {
    const label = `Step ${String(i + 1)} (`;
    if (kind === "person") {
      input.checkPerson();
      const step: ApprovalStep = {
        kind: "person",
        identity: input.person,
        decision: "approve",
        reasons: [],
        ...base,
        at: input.now().toISOString(),
      };
      await record(step, `step ${String(i + 1)} of ${String(steps.length)}`);
      if (verbose) io.write(`${label}${describe(step)}\n`);
      return { approve: true, approver: input.person, modelOnly: false };
    }
    // The project config requires `approval.model` whenever the flow has a model step.
    const modelRef = approval.model ?? "";
    const decided = await runPlanApprover(input.deps, {
      plan: input.plan,
      context: input.context,
      flags: input.flags,
      gaps: input.gaps ?? [],
      modelRef,
    });
    await input.deps.save();
    const step: ApprovalStep = {
      kind: decided.decidedBy,
      identity: decided.model,
      decision: decided.decision,
      reasons: decided.reasons,
      ...base,
      at: input.now().toISOString(),
      ...(decided.promptSha256 ? { promptSha256: decided.promptSha256 } : {}),
      ...(decided.answerSha256 ? { answerSha256: decided.answerSha256 } : {}),
    };
    await record(step, `step ${String(i + 1)} of ${String(steps.length)}`);
    io.write(`${label}${describe(step)}\n`);
    if (step.decision === "revise") {
      const instruction = step.reasons
        .map((r) => r.trim().replace(/[.;]+$/, ""))
        .join("; ")
        .replaceAll('"', "'");
      io.write(
        `The model approver asks for a revision (reasons above). Revise the plan with them:\nqajitsu plan ${session.ws.ticket} --revise "${instruction}" --run ${session.ws.runId}\n`,
      );
      return { approve: false, exitCode: 2 };
    }
    if (step.decision === "handover") {
      if (steps.slice(i + 1).includes("person")) continue;
      const confirm = [
        ...(input.plan.open_questions.length > 0 ? ["--confirm-open-questions"] : []),
        ...(input.flags.length > 0 ? ["--confirm-placeholders"] : []),
        ...((input.gaps ?? []).length > 0 ? ["--confirm-uncovered"] : []),
      ];
      io.write(
        `A person must decide: approve it with --person${confirm.length > 0 ? ` (and ${confirm.join(" and ")})` : ""}, or revise it with qajitsu plan ${session.ws.ticket} --revise "…".\n`,
      );
      return { approve: false, exitCode: 2 };
    }
    models = decided.model;
  }
  return { approve: true, approver: `model:${models ?? "unknown"}`, modelOnly: true };
}

/**
 * Records a person's approval made in the interactive review of `qj plan` (REQ-PLAN-10/AC3): a person decides at once,
 * like `qj approve --person`, and the decision is kept and commented like any step of the flow.
 */
export async function recordReviewApproval(
  session: RunSession,
  io: CommandIO,
  input: {
    readonly plan: Plan;
    readonly planText: string;
    readonly person: string;
    readonly now: () => Date;
    readonly comment?: ApprovalCommenter | undefined;
  },
): Promise<void> {
  const step: ApprovalStep = {
    kind: "person",
    identity: input.person,
    decision: "approve",
    reasons: [],
    version: input.plan.version,
    planSha256: sha256(input.planText),
    at: input.now().toISOString(),
  };
  const n = await recordApprovalStep(session, step);
  const { title, lines } = stepComment(session, step, "in the plan review");
  await input.comment?.(`approval-${String(n)}`, title, lines);
  const { flow } = session.project.config.approval;
  if (flow.length !== 1 || flow[0] !== "person")
    io.write(
      `A person approved in the review: the model steps of the approval flow (${flow.join(", ")}) were not run.\n`,
    );
}
