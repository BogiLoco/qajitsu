import type { ApprovalStep, PlanApproval, RunEvent } from "@qajitsu/core";

/** Result of {@link checkApprovalRecords}. */
export interface ApprovalCheck {
  /** No person approved the plan, by `run.json` or by the journal (fail closed). */
  readonly modelOnly: boolean;
  /** Mismatches between `run.json` and the journal; any one fails the `approval-intact` gate. */
  readonly problems: readonly string[];
}

const KEYS = [
  "kind",
  "identity",
  "decision",
  "reasons",
  "version",
  "planSha256",
  "at",
  "promptSha256",
  "answerSha256",
];
const key = (step: unknown): string => {
  const s = (step ?? {}) as Record<string, unknown>;
  return JSON.stringify(KEYS.map((k) => s[k] ?? null));
};
const label = (step: unknown): string => {
  const s = (step ?? {}) as Partial<ApprovalStep>;
  return `${String(s.kind)} ${String(s.identity)} ${String(s.decision)}`;
};

/**
 * Checks the approval records of a run against its journal (REQ-PLAN-10/AC3+AC5+AC6, ADR-0010): every step in
 * `run.json` (`approvals`) is journaled exactly as recorded and nothing journaled is missing; the frozen plan is the
 * version an approving step decided on, by the recorded approver; and a plan the journal records as approved by a
 * model only stays model-only even if `run.json` was edited. Runs approved before approval flows have no steps
 * and nothing to check.
 *
 * @param approval - `data.approval` of `run.json`.
 * @param steps - `data.approvals` of `run.json`.
 * @param events - Parsed journal events.
 */
export function checkApprovalRecords(
  approval: PlanApproval,
  steps: readonly ApprovalStep[],
  events: readonly RunEvent[],
): ApprovalCheck {
  const problems: string[] = [];
  const short = approval.sha256.slice(0, 12);
  const journaled = events.filter((e) => e.event === "approval.step").map((e) => e.details);
  const approved = events.filter(
    (e) =>
      e.event === "plan.approved" &&
      (e.details as { sha256?: unknown } | undefined)?.sha256 === approval.sha256,
  );
  const journalModelOnly = approved.some((e) => (e.details as { modelOnly?: unknown }).modelOnly === true);
  if (journalModelOnly && approval.modelOnly !== true)
    problems.push(`run.json says a person approved plan sha256 ${short}, the journal says a model only`);
  const remaining = journaled.map(key);
  steps.forEach((step, i) => {
    const at = remaining.indexOf(key(step));
    if (at === -1) problems.push(`approval step ${String(i + 1)} (${label(step)}) is not in the journal`);
    else remaining.splice(at, 1);
  });
  for (const k of remaining) {
    const detail = journaled.find((d) => key(d) === k);
    problems.push(`the journal has an approval step that run.json does not (${label(detail)})`);
  }
  if (steps.length > 0 || journaled.length > 0) {
    const decisive = steps.some(
      (s) =>
        s.decision === "approve" &&
        s.planSha256 === approval.sha256 &&
        (approval.modelOnly === true
          ? s.kind === "model" && approval.approver === `model:${s.identity}`
          : s.kind === "person" && s.identity === approval.approver),
    );
    if (!decisive) problems.push(`no approval step approved plan sha256 ${short} as ${approval.approver}`);
  }
  return { modelOnly: approval.modelOnly === true || journalModelOnly, problems };
}
