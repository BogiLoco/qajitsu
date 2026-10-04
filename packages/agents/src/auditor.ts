import { z } from "zod";
import { ConfigError, type CaseResultFile, type Plan, type TestStatus } from "@qajitsu/core";
import { UNTRUSTED_DATA_RULES, untrusted } from "./context.js";
import { runStructuredAgent } from "./loop.js";
import { AGENT_ROLES } from "./roles.js";
import { modelForRole, stageGuard, type AgentStageDeps } from "./roles-run.js";
import { createReadOnlyTools } from "./workspace-tools.js";

/** The auditor's answer: one finding per PASSED case (REQ-VER-06). */
export const AuditReportSchema = z.strictObject({
  findings: z.array(
    z.strictObject({
      caseId: z.string(),
      /** True when the PASSED result is not convincing; it can only lead to NEEDS_REVIEW. */
      weak: z.boolean(),
      reason: z.string().min(1).max(1000),
    }),
  ),
});

/** One finding of the auditor. */
export type AuditFinding = z.infer<typeof AuditReportSchema>["findings"][number];

/** A case as the auditor sees it: plan, computed status, the last attempt and its evidence. */
export interface AuditCase {
  readonly caseId: string;
  readonly status: TestStatus;
  readonly result: CaseResultFile;
  readonly evidence: readonly {
    readonly path: string;
    readonly kind: string;
    readonly stepId?: string | undefined;
  }[];
}

/** What the auditor receives (REQ-VER-06/AC1). */
export interface AuditInput {
  readonly plan: Plan;
  readonly cases: readonly AuditCase[];
  /** Masked text evidence excerpts by manifest path. */
  readonly texts: Readonly<Record<string, string>>;
  /** Screenshots of PASSED cases (shown only to models with vision). */
  readonly images: readonly {
    readonly name: string;
    readonly data: Uint8Array;
    readonly mediaType: string;
  }[];
}

/** Outcome of an audit. */
export interface AuditResult {
  readonly model: string;
  /** True when no model other than the author's was available (REQ-VER-06/AC3). */
  readonly sameModelAsAuthor: boolean;
  readonly findings: readonly AuditFinding[];
}

/** System prompt of the auditor role (REQ-VER-06). */
export const AUDITOR_SYSTEM = `You are the independent auditor of QAJitsu, an agentic QA framework.
Statuses were computed by code from the test runner. You review only the cases with status PASSED and decide whether each PASSED is convincing.
You cannot change a status. Flagging a case as weak only sends it to a human (NEEDS_REVIEW); it can never make a result better.
${UNTRUSTED_DATA_RULES}
Flag a PASSED case as weak when:
- an assertion does not check what the plan's expected result says (wrong field, a weaker check, a missing expectation);
- the evidence contradicts the pass (an error message, an error status, a screenshot that shows a failure or the wrong page);
- a step has no evidence that shows it happened, or actual values look copied from the expectation instead of observed;
- the case could not have failed (nothing in it depends on the change under test).
Do not flag for style or for things outside the plan. Use the read-only tools to open more evidence files when needed.
Answer with one JSON object only, one finding per PASSED case:
{ "findings": [{ "caseId": "TC-01", "weak": false, "reason": "short reason, cite evidence paths" }] }`;

const render = (input: AuditInput): string => {
  const passed = input.cases.filter((c) => c.status === "PASSED");
  const blocks = passed.map((c) => {
    const planCase = input.plan.cases.find((p) => p.id === c.caseId);
    const last = c.result.attempts.at(-1);
    return [
      `### ${c.caseId} (status PASSED, computed by code)`,
      "Plan (approved, trusted):",
      JSON.stringify(planCase ?? {}, null, 2),
      "Last attempt (runner output):",
      untrusted(
        `results/${c.caseId}.json`,
        JSON.stringify({ steps: last?.steps ?? [], assertions: last?.assertions ?? [] }, null, 2),
      ),
      "Evidence files:",
      c.evidence.map((e) => `- ${e.path} (${e.kind}${e.stepId ? `, step ${e.stepId}` : ""})`).join("\n") ||
        "- none",
      ...c.evidence
        .filter((e) => input.texts[e.path] !== undefined)
        .map((e) => untrusted(`evidence/${e.path}`, (input.texts[e.path] ?? "").slice(0, 2000))),
    ].join("\n");
  });
  return [
    `Ticket ${input.plan.ticket}, plan v${String(input.plan.version)}. Review these PASSED cases:`,
    ...blocks,
    input.images.length > 0
      ? `${String(input.images.length)} screenshot(s) follow, named by evidence path.`
      : "",
    "Answer with the JSON object.",
  ].join("\n\n");
};

/**
 * Stage `audit`: a separate agent with fresh context reviews every PASSED case against the approved
 * plan, the raw results and the evidence, including screenshots (REQ-VER-06/AC1). The caller applies
 * findings with `applyAuditFinding`, which can only downgrade (REQ-VER-06/AC2, invariant 5).
 *
 * @returns Findings for every PASSED case, the model used and whether it is the author's model.
 * @throws {AgentOutputError} When the auditor cannot produce a valid report.
 */
export async function runAuditor(deps: AgentStageDeps, input: AuditInput): Promise<AuditResult> {
  const role = AGENT_ROLES.find((r) => r.role === "auditor");
  if (!role) throw new ConfigError("ROLE_UNKNOWN", "Unknown role auditor.", { role: "auditor" });
  const model = await modelForRole(deps.models, "auditor");
  const author = await deps.models.forRole("author").then(
    (m) => m.id,
    () => undefined,
  );
  const actor = { kind: "agent", name: "auditor" } as const;
  const passedIds = input.cases.filter((c) => c.status === "PASSED").map((c) => c.caseId);
  deps.events.emit("audit", actor, "stage.start", { model: model.id, cases: passedIds.length });
  if (passedIds.length === 0)
    return { model: model.id, sameModelAsAuthor: model.id === author, findings: [] };
  const { value, attempts } = await runStructuredAgent({
    stage: "audit",
    role: "auditor",
    model,
    system: AUDITOR_SYSTEM,
    prompt: render(input),
    schema: AuditReportSchema,
    validate: (report) => {
      const ids = report.findings.map((f) => f.caseId);
      return [
        ...passedIds.filter((id) => !ids.includes(id)).map((id) => `findings: missing a finding for ${id}`),
        ...ids.filter((id) => !passedIds.includes(id)).map((id) => `findings: ${id} is not a PASSED case`),
        ...ids.filter((id, i) => ids.indexOf(id) !== i).map((id) => `findings: ${id} appears more than once`),
      ];
    },
    tools: createReadOnlyTools({ root: deps.ws.dir, mask: deps.maskText }),
    guard: stageGuard(deps, "audit", role),
    usage: deps.usage,
    images: input.images,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  deps.events.emit("audit", actor, "stage.end", {
    attempts,
    weak: value.findings.filter((f) => f.weak).map((f) => f.caseId),
  });
  return { model: model.id, sameModelAsAuthor: model.id === author, findings: value.findings };
}
