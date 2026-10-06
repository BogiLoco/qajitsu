import type { RunObservation } from "@qajitsu/core";
import { countStatuses, summaryLine, type MatrixRow } from "./matrix.js";

/** One failed assertion shown in the comment (REQ-PUB-01/AC3). */
export interface CommentFailure {
  readonly caseId: string;
  readonly title: string;
  readonly status: string;
  readonly stepId: string;
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  /** Names of the attachments that show this failure (screenshots, videos). */
  readonly attachments: readonly string[];
}

/** Everything the Jira comment says, computed from structured results (invariant 6). */
export interface CommentModel {
  readonly ticket: string;
  readonly runId: string;
  readonly date: string;
  readonly environment: {
    readonly name: string;
    readonly baseUrl: string;
    readonly deployedSha?: string | undefined;
    /** Stubbed services: what was not real in this run (REQ-ENV-05/AC2). */
    readonly stubs?: readonly string[] | undefined;
  };
  /** Tested repositories and SHAs (REQ-CTX-04/AC3). */
  readonly repos: Readonly<Record<string, string>>;
  readonly executor: string;
  readonly planVersion: number;
  readonly planSha256: string;
  readonly rows: readonly MatrixRow[];
  /** Validated summary text (REQ-VER-08/AC2). */
  readonly summary: string;
  readonly failures: readonly CommentFailure[];
  /** Local reproduction command (REQ-PUB-01/AC4). */
  readonly reproduce: string;
  /** Attachment names and notes about files that were not uploaded. */
  readonly attachments: readonly string[];
  readonly notes: readonly string[];
  /** Passive observations, computed by code, never statuses (REQ-EVD-07/AC4). */
  readonly observations?: readonly RunObservation[] | undefined;
  /** Fix verification lines (REQ-VER-11/AC4): verdict first, then one line per reproduction case. */
  readonly fixCheck?: readonly string[] | undefined;
}

/** Observations shown in a comment; the rest are in the report. */
const MAX_COMMENT_OBSERVATIONS = 15;
const observationLines = (m: CommentModel): string[] => {
  const all = m.observations ?? [];
  return [
    ...all.slice(0, MAX_COMMENT_OBSERVATIONS).map((o) => `${o.caseId} ${o.kind}: ${o.text}`),
    ...(all.length > MAX_COMMENT_OBSERVATIONS
      ? [`… and ${String(all.length - MAX_COMMENT_OBSERVATIONS)} more in report.html`]
      : []),
  ];
};
const OBSERVATIONS_TITLE = "Observations (found by code, not test results)";

/** Failure hints of the matrix rows (REQ-VER-12/AC3): suggestions next to, never inside, the computed results. */
const HINTS_TITLE = "Failure hints (suggestions, not statuses)";
const hintLines = (m: CommentModel): string[] =>
  m.rows.flatMap((r) => (r.hint === undefined ? [] : [`${r.caseId}: ${r.hint}`]));

const show = (v: unknown): string =>
  typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) || "undefined";

type AdfNode = Record<string, unknown>;
const text = (t: string, marks?: string[]): AdfNode => ({
  type: "text",
  text: t,
  ...(marks ? { marks: marks.map((m) => ({ type: m })) } : {}),
});
const para = (...content: AdfNode[]): AdfNode => ({
  type: "paragraph",
  content: content.filter((c) => c["text"] !== ""),
});
const heading = (level: number, t: string): AdfNode => ({
  type: "heading",
  attrs: { level },
  content: [text(t)],
});
const cell = (kind: "tableHeader" | "tableCell", t: string, marks?: string[]): AdfNode => ({
  type: kind,
  content: [para(text(t === "" ? " " : t, marks))],
});
const bullets = (items: AdfNode[][]): AdfNode => ({
  type: "bulletList",
  content: items.map((c) => ({ type: "listItem", content: [para(...c)] })),
});

const header = (m: CommentModel): string[] => [
  `Run ${m.runId} · ${m.date}`,
  `Environment: ${m.environment.name} (${m.environment.baseUrl})${m.environment.deployedSha ? `, deployed ${m.environment.deployedSha}` : ""}${m.environment.stubs?.length ? `; stubbed (not real): ${m.environment.stubs.join(", ")}` : ""}`,
  `Tested code: ${
    Object.entries(m.repos)
      .map(([k, v]) => `${k}@${v.slice(0, 12)}`)
      .join(", ") || "–"
  }`,
  `Plan v${String(m.planVersion)} (sha256 ${m.planSha256.slice(0, 12)}) · executed by ${m.executor} with QAJitsu`,
];

const MATRIX_HEADER = ["TC", "Title", "Requirement", "Type", "Status", "Steps OK"];
const rowCells = (r: MatrixRow): string[] => [
  r.caseId,
  r.title,
  r.requirement,
  r.type.toUpperCase(),
  r.status,
  `${String(r.stepsPassed)}/${String(r.stepsTotal)}`,
];

/**
 * Renders the Jira Cloud comment in Atlassian Document Format (REQ-PUB-01, REQ-PUB-03/AC1).
 *
 * @param m - Comment model.
 */
export function renderJiraAdf(m: CommentModel): { version: 1; type: "doc"; content: AdfNode[] } {
  const counts = countStatuses(m.rows);
  const content: AdfNode[] = [
    heading(3, `QAJitsu test results: ${summaryLine(m.rows)}`),
    bullets(header(m).map((h) => [text(h)])),
    para(text(m.summary)),
    {
      type: "table",
      attrs: { isNumberColumnEnabled: false, layout: "default" },
      content: [
        { type: "tableRow", content: MATRIX_HEADER.map((h) => cell("tableHeader", h)) },
        ...m.rows.map((r) => ({
          type: "tableRow",
          content: rowCells(r).map((c, i) =>
            cell("tableCell", c, i === 4 && r.status !== "PASSED" ? ["strong"] : undefined),
          ),
        })),
      ],
    },
  ];
  if (m.failures.length > 0) {
    content.push(heading(4, "Failures"));
    content.push(
      bullets(
        m.failures.map((f) => [
          text(`${f.caseId} ${f.stepId} `, ["strong"]),
          text(`${f.title}: ${f.field} expected `),
          text(show(f.expected), ["code"]),
          text(", actual "),
          text(show(f.actual), ["code"]),
          text(f.attachments.length > 0 ? ` (see ${f.attachments.join(", ")})` : ""),
        ]),
      ),
    );
  }
  if (m.fixCheck && m.fixCheck.length > 0) {
    content.push(heading(4, "Fix verification"));
    content.push(bullets(m.fixCheck.map((l) => [text(l)])));
  }
  if (hintLines(m).length > 0) {
    content.push(heading(4, HINTS_TITLE));
    content.push(bullets(hintLines(m).map((l) => [text(l)])));
  }
  const observed = observationLines(m);
  if (observed.length > 0) {
    content.push(heading(4, OBSERVATIONS_TITLE));
    content.push(bullets(observed.map((o) => [text(o)])));
  }
  content.push(heading(4, "Reproduce locally"));
  content.push({ type: "codeBlock", attrs: { language: "shell" }, content: [text(m.reproduce)] });
  if (m.attachments.length > 0 || m.notes.length > 0) {
    content.push(para(text(`Attachments: ${m.attachments.join(", ") || "none"}`)));
    for (const n of m.notes) content.push(para(text(n, ["em"])));
  }
  content.push(
    para(
      text(
        `Counts are computed from runner results: ${Object.entries(counts)
          .filter(([, n]) => n > 0)
          .map(([s, n]) => `${s} ${String(n)}`)
          .join(", ")}.`,
        ["em"],
      ),
    ),
  );
  return { version: 1, type: "doc", content };
}

const wikiEscape = (s: string): string => s.replace(/([|{}[\]*_+\-^~?])/g, "\\$1").replace(/\r?\n/g, " ");

/**
 * Renders the Jira Data Center comment in wiki markup (REQ-PUB-03/AC2).
 *
 * @param m - Comment model.
 */
export function renderJiraWiki(m: CommentModel): string {
  const lines = [
    `h3. QAJitsu test results: ${wikiEscape(summaryLine(m.rows))}`,
    ...header(m).map((h) => `* ${wikiEscape(h)}`),
    "",
    wikiEscape(m.summary),
    "",
    `||${MATRIX_HEADER.join("||")}||`,
    ...m.rows.map(
      (r) =>
        `|${rowCells(r)
          .map((c, i) => (i === 4 && r.status !== "PASSED" ? `*${wikiEscape(c)}*` : wikiEscape(c) || " "))
          .join("|")}|`,
    ),
  ];
  if (m.failures.length > 0) {
    lines.push("", "h4. Failures");
    for (const f of m.failures) {
      lines.push(
        `* *${f.caseId} ${f.stepId}* ${wikiEscape(f.title)}: ${wikiEscape(f.field)} expected {{${wikiEscape(show(f.expected))}}}, actual {{${wikiEscape(show(f.actual))}}}${f.attachments.length > 0 ? ` (see ${f.attachments.map(wikiEscape).join(", ")})` : ""}`,
      );
    }
  }
  if (m.fixCheck && m.fixCheck.length > 0)
    lines.push("", "h4. Fix verification", ...m.fixCheck.map((l) => `* ${wikiEscape(l)}`));
  if (hintLines(m).length > 0)
    lines.push("", `h4. ${HINTS_TITLE}`, ...hintLines(m).map((l) => `* ${wikiEscape(l)}`));
  const observed = observationLines(m);
  if (observed.length > 0)
    lines.push("", `h4. ${OBSERVATIONS_TITLE}`, ...observed.map((o) => `* ${wikiEscape(o)}`));
  lines.push("", "h4. Reproduce locally", `{code:shell}${m.reproduce}{code}`);
  if (m.attachments.length > 0) lines.push(`Attachments: ${m.attachments.map(wikiEscape).join(", ")}`);
  for (const n of m.notes) lines.push(`_${wikiEscape(n)}_`);
  return `${lines.join("\n")}\n`;
}

/**
 * Plain-text preview of the comment for the human confirmation step (REQ-VER-10/AC1).
 *
 * @param m - Comment model.
 */
export function renderCommentPreview(m: CommentModel): string {
  const lines = [`QAJitsu test results: ${summaryLine(m.rows)}`, ...header(m), "", m.summary, ""];
  for (const r of m.rows) lines.push(`  ${rowCells(r).join(" | ")}`);
  if (m.failures.length > 0) {
    lines.push("", "Failures:");
    for (const f of m.failures)
      lines.push(
        `  ${f.caseId} ${f.stepId} ${f.field}: expected ${show(f.expected)}, actual ${show(f.actual)}`,
      );
  }
  if (m.fixCheck && m.fixCheck.length > 0)
    lines.push("", "Fix verification:", ...m.fixCheck.map((l) => `  ${l}`));
  if (hintLines(m).length > 0) lines.push("", `${HINTS_TITLE}:`, ...hintLines(m).map((l) => `  ${l}`));
  const observed = observationLines(m);
  if (observed.length > 0) lines.push("", `${OBSERVATIONS_TITLE}:`, ...observed.map((o) => `  ${o}`));
  lines.push(
    "",
    `Reproduce: ${m.reproduce}`,
    `Attachments: ${m.attachments.join(", ") || "none"}`,
    ...m.notes,
  );
  return `${lines.join("\n")}\n`;
}
