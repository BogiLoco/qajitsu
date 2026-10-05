import type { Analysis, Plan, ReviewComment, SourceRef, Ticket } from "@qajitsu/core";

/** Line ranges a diff touches, per file: new side for added/changed files, old side for deleted ones. */
export type DiffIndex = ReadonlyMap<string, readonly (readonly [number, number])[]>;

/**
 * Indexes a unified diff (`diff --git` format) by file and hunk ranges.
 *
 * @param diff - Unified diff text.
 */
export function indexDiff(diff: string): DiffIndex {
  const files = new Map<string, [number, number][]>();
  let current: [number, number][] | undefined;
  let deleted = false;
  for (const line of diff.split("\n")) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (header?.[2] !== undefined && header[1] !== undefined) {
      current = [];
      deleted = false;
      files.set(header[2], current);
      if (header[1] !== header[2]) files.set(header[1], current);
      continue;
    }
    if (line.startsWith("deleted file mode")) deleted = true;
    const hunk = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunk && current) {
      const start = Number(deleted ? hunk[1] : hunk[3]);
      const count = Number((deleted ? hunk[2] : hunk[4]) ?? "1");
      current.push([start, start + Math.max(count, 1) - 1]);
    }
  }
  return files;
}

/** What sources are checked against. */
export interface SourceContext {
  readonly ticket: Ticket;
  /** Diff index per repository alias. */
  readonly diffs: Readonly<Record<string, DiffIndex>>;
  /** Review comments per repository alias. */
  readonly comments: Readonly<Record<string, readonly ReviewComment[]>>;
  /** Tests per tests-repository alias, from the code index of its worktree (REQ-CTX-06). */
  readonly tests?: Readonly<
    Record<string, readonly { readonly file: string; readonly titles: readonly string[] }[]>
  >;
}

/** One rejected source reference. */
export interface SourceIssue {
  /** Where the reference is, e.g. `cases.TC-02` or `risks.0`. */
  readonly where: string;
  readonly source: SourceRef;
  readonly reason: string;
}

/** A quote must have at least this many words to count as a source (REQ-PLAN-03). */
export const QUOTE_MIN_WORDS = 4;
/** A quote must have at least this many characters to count as a source (REQ-PLAN-03). */
export const QUOTE_MIN_CHARS = 20;

const normalize = (text: string): string =>
  text
    .replace(/[\s*_`]+/g, " ")
    .trim()
    .toLowerCase();

/**
 * Checks one source reference (REQ-PLAN-03/AC2).
 *
 * @returns Why the reference is invalid, or undefined when it is grounded.
 */
export function checkSource(source: SourceRef, context: SourceContext): string | undefined {
  const { ticket } = context;
  switch (source.kind) {
    case "ac": {
      const n = Number(source.id.slice(2));
      return n >= 1 && n <= ticket.acceptanceCriteria.length
        ? undefined
        : `ticket has ${String(ticket.acceptanceCriteria.length)} acceptance criteria, ${source.id} does not exist`;
    }
    case "quote": {
      const needle = normalize(source.text);
      if (needle.split(" ").length < QUOTE_MIN_WORDS || needle.length < QUOTE_MIN_CHARS) {
        return `quote is too short to ground anything (at least ${String(QUOTE_MIN_WORDS)} words and ${String(QUOTE_MIN_CHARS)} characters)`;
      }
      // Matched field by field, so a quote cannot be stitched across two fields.
      const fields = [
        ticket.summary,
        ticket.description,
        ...ticket.acceptanceCriteria,
        ...ticket.comments.map((c) => c.body),
      ];
      return fields.some((f) => normalize(f).includes(needle))
        ? undefined
        : "quote is not verbatim in the ticket snapshot";
    }
    case "diff": {
      const index = context.diffs[source.repo];
      if (!index) return `no diff for repository '${source.repo}'`;
      const ranges = index.get(source.file);
      if (!ranges) return `${source.file} is not changed in ${source.repo}`;
      if (source.lines === undefined) return undefined;
      const [from, to = from] = source.lines.split("-").map(Number) as [number, number?];
      if (to < from) return `invalid line range ${source.lines}`;
      return ranges.some(([a, b]) => from <= b && to >= a)
        ? undefined
        : `lines ${source.lines} are outside the changed hunks`;
    }
    case "comment":
      return source.index < (context.comments[source.repo]?.length ?? 0)
        ? undefined
        : `review comment #${String(source.index)} does not exist in ${source.repo}`;
  }
}

const collect = (
  items: readonly { where: string; source: readonly SourceRef[] }[],
  context: SourceContext,
): SourceIssue[] =>
  items.flatMap(({ where, source }) =>
    source.flatMap((s) => {
      const reason = checkSource(s, context);
      return reason === undefined ? [] : [{ where, source: s, reason }];
    }),
  );

/**
 * Checks every case source of a plan (REQ-PLAN-03). A non-empty result rejects the plan with the
 * offending cases listed.
 */
export function checkPlanSources(plan: Plan, context: SourceContext): SourceIssue[] {
  return collect(
    plan.cases.map((c) => ({ where: `cases.${c.id}`, source: c.source })),
    context,
  );
}

/** Checks every claim source of an analysis (REQ-PLAN-01/AC2). */
export function checkAnalysisSources(analysis: Analysis, context: SourceContext): SourceIssue[] {
  return collect(
    [
      ...analysis.endpoints.map((e, i) => ({ where: `endpoints.${String(i)}`, source: e.source })),
      ...analysis.screens.map((s, i) => ({ where: `screens.${String(i)}`, source: s.source })),
      ...analysis.risks.map((r, i) => ({ where: `risks.${String(i)}`, source: r.source })),
    ],
    context,
  );
}

/** Formats issues for an agent repair prompt or the terminal. */
export function formatSourceIssues(issues: readonly SourceIssue[]): string {
  return issues.map((i) => `${i.where}: ${JSON.stringify(i.source)} — ${i.reason}`).join("\n");
}

/**
 * Checks the plan's claims that existing tests already cover parts of the ticket (REQ-CTX-06/AC2): each must name
 * a test that exists in a tests repository of the run, and criteria it covers must exist in the ticket. A planner
 * cannot invent coverage to skip work.
 *
 * @returns Problems as `existing_coverage.<i>: <reason>`; empty when every claim holds.
 */
export function checkExistingCoverage(plan: Plan, context: SourceContext): string[] {
  const criteria = context.ticket.acceptanceCriteria.length;
  return plan.existing_coverage.flatMap((claim, i) => {
    const where = `existing_coverage.${String(i)}`;
    const files = context.tests?.[claim.repo];
    if (!files) return [`${where}: ${claim.repo} is not a tests repository of this run`];
    const file = files.find((f) => f.file === claim.file);
    if (!file) return [`${where}: ${claim.repo} has no test file ${claim.file}`];
    if (!file.titles.includes(claim.title))
      return [`${where}: no test '${claim.title}' in ${claim.repo}:${claim.file}`];
    return claim.covers
      .filter((c) => /^AC\d+$/.test(c) && Number(c.slice(2)) > criteria)
      .map((c) => `${where}: ${c} is not an acceptance criterion of the ticket`);
  });
}
