import type { TestStatus } from "@qajitsu/core";

/** One case of a regression run, with the status computed by the verifier (REQ-EXEC-17/AC3). */
export interface RegressionCaseRow {
  readonly ticket: string;
  readonly caseId: string;
  readonly title: string;
  readonly type: string;
  readonly status: TestStatus;
  /** The run of this pack in the workspace. */
  readonly runId: string;
  /** Why the case did not pass, e.g. the failed field or the hash check. */
  readonly reason?: string | undefined;
}

/** A pack that could not run at all, e.g. an invalid `expectations.yaml`. */
export interface RegressionPackProblem {
  readonly path: string;
  readonly problem: string;
}

/** A regression run over the promoted packs (REQ-EXEC-17). */
export interface RegressionModel {
  readonly date: string;
  /** Where the packs came from, e.g. `tests@3f2a9c1e (tests/qajitsu)`. */
  readonly source: string;
  readonly environment: string;
  readonly cases: readonly RegressionCaseRow[];
  readonly problems: readonly RegressionPackProblem[];
  /** Per pack, the tool and model versions that differ from when it was promoted (REQ-OBS-10/AC3). */
  readonly versionChanges?:
    readonly { readonly ticket: string; readonly changes: readonly string[] }[] | undefined;
}

const changeLines = (m: RegressionModel): string[] =>
  (m.versionChanges ?? []).flatMap((p) => p.changes.map((c) => `${p.ticket}: ${c}`));

const ORDER: readonly TestStatus[] = ["PASSED", "FAILED", "FLAKY", "BLOCKED", "NEEDS_REVIEW", "NOT_RUN"];

/** Counts of a regression run; every pack case passed when it was promoted, so a FAILED case is a regression. */
export function summarizeRegression(m: RegressionModel): {
  readonly packs: number;
  readonly counts: Readonly<Record<string, number>>;
  readonly regressions: readonly RegressionCaseRow[];
  readonly notVerified: readonly RegressionCaseRow[];
} {
  const counts: Record<string, number> = {};
  for (const c of m.cases) counts[c.status] = (counts[c.status] ?? 0) + 1;
  return {
    packs: new Set(m.cases.map((c) => c.ticket)).size,
    counts,
    regressions: m.cases.filter((c) => c.status === "FAILED"),
    notVerified: m.cases.filter((c) => c.status !== "PASSED" && c.status !== "FAILED"),
  };
}

const countText = (counts: Readonly<Record<string, number>>): string =>
  ORDER.filter((s) => (counts[s] ?? 0) > 0)
    .map((s) => `${String(counts[s])} ${s}`)
    .join(", ") || "no cases";

const headline = (m: RegressionModel): string => {
  const s = summarizeRegression(m);
  const clean =
    m.cases.length > 0 && s.regressions.length === 0 && s.notVerified.length === 0 && m.problems.length === 0;
  return `${clean ? "NO REGRESSIONS" : s.regressions.length > 0 ? `${String(s.regressions.length)} REGRESSION(S)` : "NOT VERIFIED"}: ${String(m.cases.length)} case(s) in ${String(s.packs)} pack(s): ${countText(s.counts)}${m.problems.length > 0 ? `; ${String(m.problems.length)} pack(s) could not run` : ""}.`;
};

const HEAD = ["Ticket", "Case", "Title", "Type", "Status", "Run"];
const cells = (c: RegressionCaseRow): string[] => [
  c.ticket,
  c.caseId,
  c.title,
  c.type.toUpperCase(),
  c.status,
  c.runId,
];
const lines = (rows: readonly RegressionCaseRow[]): string[] =>
  rows.map((c) => `${c.ticket} ${c.caseId} ${c.status}: ${c.title}${c.reason ? ` (${c.reason})` : ""}`);
const md = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * Markdown report of a regression run (REQ-EXEC-17/AC3): the whole suite, regressions first.
 *
 * @param m - The regression model.
 */
export function renderRegressionMarkdown(m: RegressionModel): string {
  const s = summarizeRegression(m);
  const out = [
    "# QAJitsu regression run",
    "",
    `${m.date} · ${m.source} · environment ${m.environment}`,
    "",
    `**${headline(m)}**`,
    "",
    `| ${HEAD.join(" | ")} |`,
    `| ${HEAD.map(() => "---").join(" | ")} |`,
    ...m.cases.map((c) => `| ${cells(c).map(md).join(" | ")} |`),
  ];
  if (s.regressions.length > 0)
    out.push(
      "",
      "## Regressions (passed when promoted, fail now)",
      "",
      ...lines(s.regressions).map((l) => `- ${l}`),
    );
  if (s.notVerified.length > 0)
    out.push("", "## Not verified", "", ...lines(s.notVerified).map((l) => `- ${l}`));
  if (m.problems.length > 0)
    out.push("", "## Packs that could not run", "", ...m.problems.map((p) => `- ${p.path}: ${p.problem}`));
  const changes = changeLines(m);
  if (changes.length > 0)
    out.push("", "## Versions changed since the packs were promoted", "", ...changes.map((l) => `- ${l}`));
  out.push(
    "",
    "Statuses are computed by QAJitsu from runner output; no agent or model took part in this run.",
  );
  return `${out.join("\n")}\n`;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Static HTML report of a regression run, without scripts (REQ-EXEC-17/AC3).
 *
 * @param m - The regression model.
 */
export function renderRegressionHtml(m: RegressionModel): string {
  const s = summarizeRegression(m);
  const list = (title: string, items: readonly string[]): string =>
    items.length === 0
      ? ""
      : `<h2>${esc(title)}</h2><ul>${items.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>`;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>QAJitsu regression run</title>
<style>body{font:14px/1.4 system-ui,sans-serif;margin:24px;color:#1d2330}table{border-collapse:collapse}td,th{border:1px solid #dde1e7;padding:4px 8px;text-align:left}.PASSED{background:#d8f3dc}.FAILED{background:#ffd6d6}.BLOCKED,.NOT_RUN,.FLAKY,.NEEDS_REVIEW{background:#fff1c2}</style>
</head><body>
<h1>QAJitsu regression run</h1>
<p>${esc(`${m.date} · ${m.source} · environment ${m.environment}`)}</p>
<p><strong>${esc(headline(m))}</strong></p>
<table><thead><tr>${HEAD.map((h) => `<th>${h}</th>`).join("")}</tr></thead><tbody>
${m.cases
  .map(
    (c) =>
      `<tr>${cells(c)
        .map((v, i) => `<td${i === 4 ? ` class="${c.status}"` : ""}>${esc(v)}</td>`)
        .join("")}</tr>`,
  )
  .join("\n")}
</tbody></table>
${list("Regressions (passed when promoted, fail now)", lines(s.regressions))}
${list("Not verified", lines(s.notVerified))}
${list(
  "Packs that could not run",
  m.problems.map((p) => `${p.path}: ${p.problem}`),
)}
${list("Versions changed since the packs were promoted", changeLines(m))}
<p>Statuses are computed by QAJitsu from runner output; no agent or model took part in this run.</p>
</body></html>
`;
}

/**
 * JUnit XML of a regression run: one test suite per pack (REQ-EXEC-17/AC3).
 *
 * @param m - The regression model.
 */
export function renderRegressionJUnit(m: RegressionModel): string {
  const tickets = [...new Set(m.cases.map((c) => c.ticket))];
  const suites = tickets.map((t) => {
    const rows = m.cases.filter((c) => c.ticket === t);
    const failures = rows.filter((c) => c.status === "FAILED").length;
    const skipped = rows.filter((c) => c.status === "NOT_RUN").length;
    const errors = rows.length - failures - skipped - rows.filter((c) => c.status === "PASSED").length;
    const body = rows
      .map((c) => {
        const open = `    <testcase classname="${esc(`regression.${t}`)}" name="${esc(`${c.caseId} ${c.title}`)}"`;
        const msg = esc(`${c.status}${c.reason ? `: ${c.reason}` : ""}`);
        if (c.status === "PASSED") return `${open}/>`;
        if (c.status === "FAILED") return `${open}><failure message="${msg}"/></testcase>`;
        if (c.status === "NOT_RUN") return `${open}><skipped message="${msg}"/></testcase>`;
        return `${open}><error message="${msg}"/></testcase>`;
      })
      .join("\n");
    return `  <testsuite name="${esc(`regression ${t}`)}" tests="${String(rows.length)}" failures="${String(failures)}" errors="${String(errors)}" skipped="${String(skipped)}">\n${body}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="qajitsu regression">\n${suites.join("\n")}\n</testsuites>\n`;
}

const wikiEscape = (s: string): string => s.replace(/([|{}[\]*_+\-^~?])/g, "\\$1").replace(/\r?\n/g, " ");

/**
 * The regression report as Jira wiki markup (Data Center) and ADF (Cloud) for publishing after preview
 * (REQ-EXEC-17/AC4).
 *
 * @param m - The regression model.
 */
export function renderRegressionComment(m: RegressionModel): { wiki: string; adf: Record<string, unknown> } {
  const s = summarizeRegression(m);
  const groups: [string, string[]][] = [
    ["Regressions (passed when promoted, fail now)", lines(s.regressions)],
    ["Not verified", lines(s.notVerified)],
    ["Packs that could not run", m.problems.map((p) => `${p.path}: ${p.problem}`)],
    ["Versions changed since the packs were promoted", changeLines(m)],
  ];
  const wiki = [
    "h3. QAJitsu regression run",
    wikiEscape(`${m.date} · ${m.source} · environment ${m.environment}`),
    `*${wikiEscape(headline(m))}*`,
    ...groups.flatMap(([title, items]) =>
      items.length === 0 ? [] : [`h4. ${wikiEscape(title)}`, ...items.map((l) => `* ${wikiEscape(l)}`)],
    ),
  ].join("\n");
  const text = (t: string, strong = false): Record<string, unknown> => ({
    type: "text",
    text: t === "" ? " " : t,
    ...(strong ? { marks: [{ type: "strong" }] } : {}),
  });
  const para = (...content: Record<string, unknown>[]): Record<string, unknown> => ({
    type: "paragraph",
    content,
  });
  const content: Record<string, unknown>[] = [
    { type: "heading", attrs: { level: 3 }, content: [text("QAJitsu regression run")] },
    para(text(`${m.date} · ${m.source} · environment ${m.environment}`)),
    para(text(headline(m), true)),
  ];
  for (const [title, items] of groups)
    if (items.length > 0)
      content.push(
        { type: "heading", attrs: { level: 4 }, content: [text(title)] },
        { type: "bulletList", content: items.map((l) => ({ type: "listItem", content: [para(text(l))] })) },
      );
  return { wiki: `${wiki}\n`, adf: { version: 1, type: "doc", content } };
}
