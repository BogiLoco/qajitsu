import type { ExplorerReport } from "@qajitsu/agents";
import { ConfigError, type ChecklistItem, type Finding } from "@qajitsu/core";

/**
 * The checklist given with `--check` (REQ-EXEC-25/AC1): at most 30 items of up to 300 characters, none empty.
 *
 * @param raw - Values of the repeatable option.
 * @returns The trimmed items, in order.
 */
export function checkOption(raw: readonly string[] | undefined): string[] {
  const checks = (raw ?? []).map((c) => c.trim());
  if (checks.length > 30 || checks.some((c) => c === "" || c.length > 300))
    throw new ConfigError(
      "OPTION_INVALID",
      "--check takes at most 30 items, each one to 300 characters and not empty.",
      {},
    );
  return checks;
}

const NOT_REACHED: Record<string, string> = {
  finished: "the explorer gave no answer",
  "time-box": "the time box was reached",
  "step-budget": "the step budget was used",
  error: "the session stopped with an error",
};

/**
 * The checklist and findings a session keeps (REQ-EXEC-25/AC2+AC5): the checked answer of the explorer, with the
 * person's item texts; without an accepted answer every `--check` item is not reached, never done.
 *
 * @param checks - Items of `--check`.
 * @param report - The explorer's accepted answer, if any.
 * @param endReason - Why the session ended.
 * @param mask - Masking of everything written to the session.
 */
export function sessionClaims(
  checks: readonly string[],
  report: ExplorerReport | undefined,
  endReason: string,
  mask: (t: string) => string,
): { checklist: ChecklistItem[]; findings: Finding[] } {
  if (!report)
    return {
      checklist: checks.map((c) => ({
        item: mask(c),
        source: "person",
        actions: [],
        notDone: `not reached: ${NOT_REACHED[endReason] ?? endReason}`,
      })),
      findings: [],
    };
  return {
    checklist: report.checklist.map((e, i) => ({
      item: mask(checks[i] ?? e.item),
      source: checks.length > 0 ? "person" : "explorer",
      actions: e.actions,
      ...(e.actions.length === 0 ? { notDone: mask(e.not_done ?? "not done") } : {}),
    })),
    findings: report.findings.map((f) => ({ text: mask(f.text), actions: f.actions })),
  };
}

/**
 * One line for the terminal after a session (REQ-EXEC-25/AC6): how many checklist items were done, which were not.
 *
 * @param checklist - The session's checklist.
 * @returns The line, or nothing for a session without a checklist.
 */
export function checklistLine(checklist: readonly ChecklistItem[]): string | undefined {
  if (checklist.length === 0) return undefined;
  const undone = checklist.filter((c) => c.actions.length === 0);
  return `Checklist: ${String(checklist.length - undone.length)} of ${String(checklist.length)} item(s) done${undone.length > 0 ? `; not done: ${undone.map((c) => `"${c.item}" (${c.notDone ?? "not done"})`).join(", ")}` : ""}.`;
}
