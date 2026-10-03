import { TEST_STATUSES, type TestStatus } from "@qajitsu/core";
import { countStatuses, summaryLine, type MatrixRow } from "./matrix.js";

/**
 * Template summary built only from computed values; the fallback when an LLM summary fails
 * validation (REQ-VER-08/AC2).
 *
 * @param rows - Matrix rows.
 */
export function templateSummary(rows: readonly MatrixRow[]): string {
  const notPassed = rows.filter((r) => r.status !== "PASSED");
  return [summaryLine(rows) + ".", ...notPassed.map((r) => `${r.caseId} ${r.status}: ${r.title}.`)].join(
    "\n",
  );
}

const STATUS = TEST_STATUSES.join("|");

/**
 * Validates an LLM-written summary against computed results (REQ-VER-08/AC2, invariant 6): every
 * number tied to a status equals the computed count, a total of cases equals the row count, every
 * case id exists, and a case id named with a status has that status.
 *
 * @param text - Summary text.
 * @param rows - Matrix rows.
 * @returns Problems; empty when the summary is consistent.
 */
export function validateSummary(text: string, rows: readonly MatrixRow[]): string[] {
  const problems: string[] = [];
  const counts = countStatuses(rows);
  const byId = new Map(rows.map((r) => [r.caseId, r.status]));
  const numberStatus = new RegExp(
    `(?<![-\\w])(\\d+)\\s+(?:cases?\\s+|tests?\\s+)?(${STATUS})\\b|\\b(${STATUS})\\s*[:=]\\s*(\\d+)\\b`,
    "gi",
  );
  for (const m of text.matchAll(numberStatus)) {
    const n = Number(m[1] ?? m[4]);
    const status = (m[2] ?? m[3] ?? "").toUpperCase() as TestStatus;
    if (counts[status] !== n)
      problems.push(`says ${String(n)} ${status}, computed ${String(counts[status])}`);
  }
  for (const m of text.matchAll(
    /(?<![-\w])(\d+)\s+(?:test\s+)?cases?\b(?!\s+(?:PASSED|FAILED|FLAKY|BLOCKED|NOT_RUN|NEEDS_REVIEW))/gi,
  )) {
    if (Number(m[1]) !== rows.length)
      problems.push(`says ${m[1] ?? ""} cases, computed ${String(rows.length)}`);
  }
  for (const sentence of text.split(/(?<=[.!?\n])/)) {
    const ids = [...sentence.matchAll(/\bTC-\d{2,4}\b/g)].map((m) => m[0]);
    const statuses = [...sentence.matchAll(new RegExp(`\\b(${STATUS})\\b`, "g"))].map(
      (m) => m[1] as TestStatus,
    );
    for (const id of ids) {
      const actual = byId.get(id);
      if (actual === undefined) {
        problems.push(`mentions ${id}, which is not in the plan`);
        continue;
      }
      if (ids.length === 1 && statuses.length === 1 && statuses[0] !== actual)
        problems.push(`says ${id} is ${String(statuses[0])}, computed ${actual}`);
    }
  }
  return problems;
}

/**
 * Returns the LLM summary when it is consistent, otherwise the template summary.
 *
 * @param llmSummary - Candidate text, or undefined when no model summarised.
 * @param rows - Matrix rows.
 */
export function chooseSummary(
  llmSummary: string | undefined,
  rows: readonly MatrixRow[],
): { text: string; source: "llm" | "template"; problems: string[] } {
  if (llmSummary === undefined || llmSummary.trim() === "")
    return { text: templateSummary(rows), source: "template", problems: [] };
  const problems = validateSummary(llmSummary, rows);
  return problems.length === 0
    ? { text: llmSummary.trim(), source: "llm", problems }
    : { text: templateSummary(rows), source: "template", problems };
}
