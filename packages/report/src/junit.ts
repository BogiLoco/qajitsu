import type { TestStatus } from "@qajitsu/core";

/** One case for the JUnit report, built from computed statuses (invariant 6). */
export interface JUnitCase {
  readonly caseId: string;
  readonly title: string;
  readonly type: string;
  readonly status: TestStatus;
  readonly durationMs?: number | undefined;
  readonly failures: readonly {
    readonly stepId: string;
    readonly field: string;
    readonly expected: unknown;
    readonly actual: unknown;
  }[];
  readonly error?: string | undefined;
  /** Path of the HTML report, linked from every case. */
  readonly reportPath?: string | undefined;
}

/** Whether XML 1.0 can carry this code point (tab, line feed, carriage return, and the printable ranges). */
const xmlChar = (c: number): boolean =>
  c === 0x09 ||
  c === 0x0a ||
  c === 0x0d ||
  (c >= 0x20 && c <= 0xd7ff) ||
  (c >= 0xe000 && c <= 0xfffd) ||
  c >= 0x10000;

const xml = (s: string): string =>
  s
    // Characters XML 1.0 cannot carry are dropped (control characters from logs).
    .replace(/./gsu, (ch) => (xmlChar(ch.codePointAt(0) ?? 0) ? ch : ""))
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/**
 * Renders a JUnit XML report for pipelines (REQ-CI-04/AC2). FAILED cases are `<failure>` with expected and
 * actual values; BLOCKED, NOT_RUN, FLAKY and NEEDS_REVIEW are `<skipped>` with the status as message, which
 * matches the exit codes: only FAILED turns a pipeline red by itself.
 *
 * @param suite - Ticket and run id.
 * @param cases - Cases with computed statuses.
 */
export function renderJUnit(
  suite: { readonly ticket: string; readonly runId: string },
  cases: readonly JUnitCase[],
): string {
  const failures = cases.filter((c) => c.status === "FAILED").length;
  const skipped = cases.filter((c) => c.status !== "PASSED" && c.status !== "FAILED").length;
  const seconds = (ms: number | undefined) => ((ms ?? 0) / 1000).toFixed(3);
  const total = cases.reduce((n, c) => n + (c.durationMs ?? 0), 0);
  const body = cases.map((c) => {
    const head = `    <testcase classname="${xml(`${suite.ticket}.${c.type}`)}" name="${xml(`${c.caseId} ${c.title}`)}" time="${seconds(c.durationMs)}">`;
    const props = `      <properties><property name="qajitsu.status" value="${c.status}"/>${c.reportPath ? `<property name="qajitsu.report" value="${xml(c.reportPath)}"/>` : ""}</properties>`;
    let outcome = "";
    if (c.status === "FAILED") {
      const lines = c.failures.map(
        (f) =>
          `${f.stepId} ${f.field}: expected ${JSON.stringify(f.expected)}, actual ${JSON.stringify(f.actual)}`,
      );
      const first = lines[0] ?? c.error ?? "failed";
      outcome = `\n      <failure message="${xml(first)}" type="FAILED">${xml([...lines, ...(c.error ? [c.error] : [])].join("\n"))}</failure>`;
    } else if (c.status !== "PASSED") {
      outcome = `\n      <skipped message="${xml(`${c.status}${c.error ? `: ${c.error}` : ""}`)}"/>`;
    }
    return `${head}\n${props}${outcome}\n    </testcase>`;
  });
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<testsuites name="QAJitsu" tests="${String(cases.length)}" failures="${String(failures)}" skipped="${String(skipped)}" time="${seconds(total)}">`,
    `  <testsuite name="${xml(`${suite.ticket} ${suite.runId}`)}" tests="${String(cases.length)}" failures="${String(failures)}" errors="0" skipped="${String(skipped)}" time="${seconds(total)}">`,
    ...body,
    "  </testsuite>",
    "</testsuites>",
    "",
  ].join("\n");
}
