import { TEST_STATUSES, type TestStatus } from "@qajitsu/core";

/** One row of the test matrix: one case of the approved plan (REQ-EVD-04). */
export interface MatrixRow {
  readonly caseId: string;
  readonly title: string;
  readonly requirement: string;
  readonly type: "api" | "web" | "mobile";
  readonly status: TestStatus;
  readonly stepsPassed: number;
  readonly stepsTotal: number;
  readonly evidence: string;
}

/** Counts per status, computed by code (REQ-VER-08, invariant 6). */
export type StatusCounts = Readonly<Record<TestStatus, number>>;

/**
 * Counts statuses across rows.
 *
 * @param rows - Matrix rows.
 * @returns A count for every status, zeros included.
 */
export function countStatuses(rows: readonly MatrixRow[]): StatusCounts {
  const counts = Object.fromEntries(TEST_STATUSES.map((s) => [s, 0])) as Record<TestStatus, number>;
  for (const row of rows) counts[row.status] += 1;
  return counts;
}

/**
 * One-line summary such as `4 cases: 2 PASSED, 1 FAILED, 1 BLOCKED`. Only non-zero statuses are listed.
 */
export function summaryLine(rows: readonly MatrixRow[]): string {
  const counts = countStatuses(rows);
  const parts = TEST_STATUSES.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  const noun = rows.length === 1 ? "case" : "cases";
  return parts.length > 0 ? `${rows.length} ${noun}: ${parts.join(", ")}` : `0 cases`;
}

const cell = (value: string): string => value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * Renders the matrix as Markdown, the basis of the Jira comment (REQ-EVD-05, REQ-PUB-01).
 *
 * @param rows - Rows in approved-plan order.
 * @returns Markdown with a summary line and a table.
 */
export function renderMatrixMarkdown(rows: readonly MatrixRow[]): string {
  const header =
    "| TC | Title | Requirement | Type | Status | Steps OK | Evidence |\n| --- | --- | --- | --- | --- | --- | --- |";
  const body = rows
    .map(
      (r) =>
        `| ${cell(r.caseId)} | ${cell(r.title)} | ${cell(r.requirement)} | ${r.type.toUpperCase()} | ${r.status} | ${r.stepsPassed}/${r.stepsTotal} | ${cell(r.evidence)} |`,
    )
    .join("\n");
  return `**${summaryLine(rows)}**\n\n${header}${body ? `\n${body}` : ""}\n`;
}
