/** Everything a bug report contains, all taken from the run's files (REQ-PUB-07/AC2+AC3). */
export interface BugReportModel {
  readonly ticket: string;
  readonly runId: string;
  readonly caseId: string;
  readonly title: string;
  /** Failed assertions: expected from the approved plan, actual from the runner. */
  readonly failures: readonly {
    readonly stepId: string;
    readonly field: string;
    readonly expected: unknown;
    readonly actual: unknown;
  }[];
  readonly error?: string | undefined;
  readonly preconditions: readonly string[];
  /** Test data aliases, e.g. `user: user:standard`. */
  readonly data: Readonly<Record<string, string>>;
  /** Steps of the approved plan with what the runner recorded for each. */
  readonly steps: readonly {
    readonly id: string;
    readonly action: string;
    readonly outcome: "ok" | "failed" | "not run";
    readonly detail?: string | undefined;
  }[];
  readonly environment: {
    readonly name: string;
    readonly baseUrl: string;
    readonly deployedSha?: string | undefined;
  };
  readonly repos: Readonly<Record<string, string>>;
  /** Browser or device the case ran on. */
  readonly client?: string | undefined;
  readonly evidence: readonly { readonly path: string; readonly kind: string; readonly sha256: string }[];
  /** Suggested cause (REQ-VER-12), labelled as unverified. */
  readonly hint?: string | undefined;
  readonly reproduce: string;
}

const show = (v: unknown): string => (typeof v === "string" ? v : JSON.stringify(v));

/** The summary line: the case and its first failure, at most 240 characters. */
export function bugSummary(m: BugReportModel): string {
  const first = m.failures[0];
  const what = first
    ? `${first.stepId} ${first.field} expected ${show(first.expected)} but was ${show(first.actual)}`
    : (m.error ?? "failed");
  const line = `${m.title}: ${what}`.replace(/\s+/g, " ");
  return line.length > 240 ? `${line.slice(0, 239)}…` : line;
}

interface Section {
  readonly title: string;
  readonly lines: readonly string[];
  readonly numbered?: boolean;
}

const sections = (m: BugReportModel): Section[] => [
  {
    title: "Found by",
    lines: [`QAJitsu run ${m.runId} while testing ${m.ticket}, case ${m.caseId} "${m.title}".`],
  },
  ...(m.preconditions.length > 0 || Object.keys(m.data).length > 0
    ? [
        {
          title: "Preconditions",
          lines: [...m.preconditions, ...Object.entries(m.data).map(([k, v]) => `Test data ${k}: ${v}`)],
        },
      ]
    : []),
  {
    title: "Steps to reproduce (approved test plan, with what the runner recorded)",
    numbered: true,
    lines: m.steps.map((s) => `${s.id}: ${s.action} (${s.outcome}${s.detail ? `: ${s.detail}` : ""})`),
  },
  {
    title: "Expected (approved test plan) and actual (runner)",
    lines:
      m.failures.length > 0
        ? m.failures.map(
            (f) => `${f.stepId} ${f.field}: expected ${show(f.expected)}, actual ${show(f.actual)}`,
          )
        : [m.error ?? "The case failed without a recorded assertion."],
  },
  {
    title: "Tested version",
    lines: [
      `Environment: ${m.environment.name} (${m.environment.baseUrl})${m.environment.deployedSha ? `, deployed ${m.environment.deployedSha}` : ""}`,
      ...Object.entries(m.repos).map(([alias, sha]) => `Repository ${alias} at ${sha}`),
      ...(m.client ? [`Client: ${m.client}`] : []),
    ],
  },
  {
    title: "Evidence (in the run folder and the evidence zip on the ticket, by SHA-256)",
    lines:
      m.evidence.length > 0
        ? m.evidence.map((e) => `${e.path} (${e.kind}) sha256 ${e.sha256.slice(0, 16)}…`)
        : ["none"],
  },
  ...(m.hint ? [{ title: "Suggested cause (a hint, not verified)", lines: [m.hint] }] : []),
  { title: "Reproduce locally", lines: [m.reproduce] },
];

type AdfNode = Record<string, unknown>;
const text = (t: string): AdfNode => ({ type: "text", text: t });
const heading = (t: string): AdfNode => ({ type: "heading", attrs: { level: 4 }, content: [text(t)] });
const list = (lines: readonly string[], numbered: boolean): AdfNode => ({
  type: numbered ? "orderedList" : "bulletList",
  content: lines.map((l) => ({ type: "listItem", content: [{ type: "paragraph", content: [text(l)] }] })),
});
const wikiEscape = (s: string): string => s.replace(/([|{}[\]*_+\-^~?])/g, "\\$1").replace(/\r?\n/g, " ");

/**
 * Renders a bug report from the run (REQ-PUB-07/AC2+AC3): steps from the approved plan with the runner's record,
 * expected values from the plan, actual values from the runner, the tested version and evidence by hash. No model
 * writes any of it. The caller masks the result before it leaves the machine (AC5).
 *
 * @returns Summary, ADF (Jira Cloud), wiki markup (Data Center) and plain text (preview).
 */
export function renderBugReport(m: BugReportModel): {
  summary: string;
  adf: { version: 1; type: "doc"; content: AdfNode[] };
  wiki: string;
  text: string;
} {
  const all = sections(m);
  return {
    summary: bugSummary(m),
    adf: {
      version: 1,
      type: "doc",
      content: all.flatMap((s) => [heading(s.title), list(s.lines, s.numbered === true)]),
    },
    wiki: all
      .map((s) =>
        [
          `h4. ${wikiEscape(s.title)}`,
          ...s.lines.map((l) => `${s.numbered ? "#" : "*"} ${wikiEscape(l)}`),
        ].join("\n"),
      )
      .join("\n\n"),
    text: all
      .map((s) =>
        [`${s.title}:`, ...s.lines.map((l, i) => `  ${s.numbered ? `${String(i + 1)}.` : "-"} ${l}`)].join(
          "\n",
        ),
      )
      .join("\n\n"),
  };
}
