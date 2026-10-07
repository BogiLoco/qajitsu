/** Statuses in the order the release report shows them. */
const ORDER = ["PASSED", "FAILED", "FLAKY", "BLOCKED", "NEEDS_REVIEW", "NOT_RUN"] as const;

/** One ticket of a release with its latest run, all numbers computed from structured results (REQ-PUB-09/AC3). */
export interface ReleaseTicketRow {
  readonly key: string;
  readonly summary: string;
  /** Workflow status in the ticket system, shown as is. */
  readonly ticketStatus: string;
  /** The run the numbers come from; undefined when the ticket has no executed run. */
  readonly runId?: string | undefined;
  /** Case counts by computed status. */
  readonly counts: Readonly<Record<string, number>>;
  /** Cases that are not PASSED: FAILED, FLAKY, BLOCKED, NEEDS_REVIEW, NOT_RUN. */
  readonly open: readonly { readonly caseId: string; readonly title: string; readonly status: string }[];
  /** Publish gates of the run passed (hashes, evidence, coverage). */
  readonly gatesOk: boolean;
  /** Why the run cannot be trusted or read, e.g. failed gates. */
  readonly problem?: string | undefined;
}

/** A release readiness report (REQ-PUB-09). */
export interface ReleaseModel {
  readonly name: string;
  readonly by: "fixVersion" | "sprint";
  readonly date: string;
  readonly tickets: readonly ReleaseTicketRow[];
}

/** Readiness of one ticket: only a trusted run with every case PASSED is ready. */
export type TicketReadiness = "ready" | "not ready" | "no run" | "untrusted";

/**
 * Readiness of one ticket. A ticket without results is never ready (REQ-PUB-09/AC3), and neither is a run whose
 * publish gates failed: its numbers cannot be trusted.
 *
 * @param row - Ticket row.
 * @returns The readiness.
 */
export function ticketReadiness(row: ReleaseTicketRow): TicketReadiness {
  if (row.runId === undefined) return "no run";
  if (!row.gatesOk || row.problem !== undefined) return "untrusted";
  const total = Object.values(row.counts).reduce((a, b) => a + b, 0);
  return total > 0 && (row.counts["PASSED"] ?? 0) === total ? "ready" : "not ready";
}

/** Counts of a release computed from its rows. */
export interface ReleaseSummary {
  readonly tickets: number;
  readonly ready: number;
  readonly notReady: number;
  readonly noRun: number;
  readonly untrusted: number;
  /** Case counts by status over every ticket with a run. */
  readonly cases: Readonly<Record<string, number>>;
  /** True only when there is at least one ticket and every ticket is ready. */
  readonly releaseReady: boolean;
}

/**
 * Computes the release counts from the ticket rows.
 *
 * @param m - Release model.
 * @returns The summary.
 */
export function summarizeRelease(m: ReleaseModel): ReleaseSummary {
  const by = m.tickets.map(ticketReadiness);
  const cases: Record<string, number> = {};
  for (const row of m.tickets)
    if (row.runId !== undefined)
      for (const [status, n] of Object.entries(row.counts)) cases[status] = (cases[status] ?? 0) + n;
  const ready = by.filter((r) => r === "ready").length;
  return {
    tickets: m.tickets.length,
    ready,
    notReady: by.filter((r) => r === "not ready").length,
    noRun: by.filter((r) => r === "no run").length,
    untrusted: by.filter((r) => r === "untrusted").length,
    cases,
    releaseReady: m.tickets.length > 0 && ready === m.tickets.length,
  };
}

const countText = (counts: Readonly<Record<string, number>>): string => {
  const parts = ORDER.filter((s) => (counts[s] ?? 0) > 0).map((s) => `${String(counts[s])} ${s}`);
  return parts.length > 0 ? parts.join(", ") : "no cases";
};

const headline = (m: ReleaseModel, s: ReleaseSummary): string =>
  `${s.releaseReady ? "READY" : "NOT READY"}: ${String(s.ready)} of ${String(s.tickets)} ticket(s) ready` +
  [
    s.notReady > 0 ? `, ${String(s.notReady)} not ready` : "",
    s.untrusted > 0 ? `, ${String(s.untrusted)} untrusted` : "",
    s.noRun > 0 ? `, ${String(s.noRun)} without a run` : "",
  ].join("") +
  (m.tickets.length === 0 ? " (no tickets found)" : "") +
  ".";

const title = (m: ReleaseModel): string =>
  `Release readiness: ${m.by === "sprint" ? "sprint" : "fix version"} ${m.name}`;

const rowCells = (r: ReleaseTicketRow): string[] => [
  r.key,
  r.summary,
  r.ticketStatus,
  ticketReadiness(r),
  r.runId ?? "–",
  r.runId === undefined ? "–" : countText(r.counts),
];

const HEAD = ["Ticket", "Summary", "Ticket status", "Readiness", "Run", "Cases"];

const openLines = (m: ReleaseModel): string[] =>
  m.tickets.flatMap((r) => r.open.map((o) => `${r.key} ${o.caseId} ${o.status}: ${o.title}`));

const problemLines = (m: ReleaseModel): string[] =>
  m.tickets.flatMap((r) => {
    const readiness = ticketReadiness(r);
    if (readiness === "no run") return [`${r.key}: no executed run; not tested.`];
    if (readiness === "untrusted")
      return [`${r.key} run ${r.runId ?? ""}: ${r.problem ?? "publish gates failed"}.`];
    return [];
  });

const mdCell = (s: string): string => s.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/**
 * Markdown release report written to `exports/releases/` (REQ-PUB-09/AC1+AC2).
 *
 * @param m - Release model.
 * @returns Markdown text.
 */
export function renderReleaseMarkdown(m: ReleaseModel): string {
  const s = summarizeRelease(m);
  const lines = [
    `# ${title(m)}`,
    "",
    `${m.date} · ${headline(m, s)}`,
    "",
    `Cases over all runs: ${countText(s.cases)}.`,
    "",
    `| ${HEAD.join(" | ")} |`,
    `| ${HEAD.map(() => "---").join(" | ")} |`,
    ...m.tickets.map((r) => `| ${rowCells(r).map(mdCell).join(" | ")} |`),
  ];
  const open = openLines(m);
  if (open.length > 0) lines.push("", "## Open cases", "", ...open.map((l) => `- ${l}`));
  const problems = problemLines(m);
  if (problems.length > 0)
    lines.push("", "## Without trustworthy results", "", ...problems.map((l) => `- ${l}`));
  lines.push(
    "",
    "Numbers are computed from each ticket's latest executed run; a ticket without a run is never ready.",
  );
  return `${lines.join("\n")}\n`;
}

const wikiEscape = (s: string): string => s.replace(/([|{}[\]*_+\-^~?])/g, "\\$1").replace(/\r?\n/g, " ");

/**
 * Jira wiki markup of the release report, for Data Center (REQ-PUB-09/AC4).
 *
 * @param m - Release model.
 * @returns Wiki markup.
 */
export function renderReleaseWiki(m: ReleaseModel): string {
  const s = summarizeRelease(m);
  const lines = [
    `h3. ${wikiEscape(title(m))}`,
    `${wikiEscape(m.date)} · *${wikiEscape(headline(m, s))}*`,
    `Cases over all runs: ${wikiEscape(countText(s.cases))}.`,
    `||${HEAD.join("||")}||`,
    ...m.tickets.map((r) => `|${rowCells(r).map(wikiEscape).join("|")}|`),
  ];
  const open = openLines(m);
  if (open.length > 0) lines.push("h4. Open cases", ...open.map((l) => `* ${wikiEscape(l)}`));
  const problems = problemLines(m);
  if (problems.length > 0)
    lines.push("h4. Without trustworthy results", ...problems.map((l) => `* ${wikiEscape(l)}`));
  return `${lines.join("\n")}\n`;
}

type AdfNode = Record<string, unknown>;
const text = (t: string, strong = false): AdfNode => ({
  type: "text",
  text: t === "" ? " " : t,
  ...(strong ? { marks: [{ type: "strong" }] } : {}),
});
const para = (...content: AdfNode[]): AdfNode => ({ type: "paragraph", content });
const heading = (level: number, t: string): AdfNode => ({
  type: "heading",
  attrs: { level },
  content: [text(t)],
});
const bullets = (items: readonly string[]): AdfNode => ({
  type: "bulletList",
  content: items.map((l) => ({ type: "listItem", content: [para(text(l))] })),
});
const cell = (kind: "tableHeader" | "tableCell", t: string): AdfNode => ({
  type: kind,
  content: [para(text(t))],
});

/**
 * Atlassian Document Format of the release report, for Jira Cloud (REQ-PUB-09/AC4).
 *
 * @param m - Release model.
 * @returns ADF document.
 */
export function renderReleaseAdf(m: ReleaseModel): { version: 1; type: "doc"; content: AdfNode[] } {
  const s = summarizeRelease(m);
  const content: AdfNode[] = [
    heading(3, title(m)),
    para(text(`${m.date} · `), text(headline(m, s), true)),
    para(text(`Cases over all runs: ${countText(s.cases)}.`)),
    {
      type: "table",
      content: [
        { type: "tableRow", content: HEAD.map((h) => cell("tableHeader", h)) },
        ...m.tickets.map((r) => ({
          type: "tableRow",
          content: rowCells(r).map((c) => cell("tableCell", c)),
        })),
      ],
    },
  ];
  const open = openLines(m);
  if (open.length > 0) content.push(heading(4, "Open cases"), bullets(open));
  const problems = problemLines(m);
  if (problems.length > 0) content.push(heading(4, "Without trustworthy results"), bullets(problems));
  return { version: 1, type: "doc", content };
}
