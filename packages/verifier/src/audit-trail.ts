import {
  AGENT_TRANSCRIPT_FILE,
  checkJournal,
  checkTranscript,
  parseEventLines,
  type ApprovalStep,
  type PlanApproval,
} from "@qajitsu/core";
import { checkApprovalRecords } from "./approval.js";

/** What a file of the audit trail is (REQ-VER-16/AC1). */
export type TrailCategory =
  | "ticket"
  | "change"
  | "context"
  | "plan"
  | "tests"
  | "runner"
  | "evidence"
  | "checks"
  | "report"
  | "journal"
  | "agents"
  | "explore"
  | "run"
  | "other";

/** One file of the trail with its SHA-256. */
export interface TrailItem {
  readonly category: TrailCategory;
  readonly path: string;
  readonly sha256: string;
}

/** The audit trail of one run: every file with its hash, and what is missing or does not match. */
export interface AuditTrail {
  readonly items: readonly TrailItem[];
  /** Gaps (REQ-VER-16/AC4); a trail with gaps cannot be certified. */
  readonly gaps: readonly string[];
}

/** Everything the trail is computed from, read by the caller. */
export interface AuditTrailInput {
  /** Run-relative path → SHA-256 of every file of the run folder that belongs to the trail. */
  readonly files: ReadonlyMap<string, string>;
  /** `run.json` `repos`. */
  readonly repos: Readonly<Record<string, { readonly sha?: string; readonly change?: string }>>;
  /** `run.json` `data`. */
  readonly data: Readonly<Record<string, unknown>>;
  /** Content of `journal/events.jsonl`. */
  readonly events?: string | undefined;
  /** Content of `journal/agents.jsonl`. */
  readonly transcript?: string | undefined;
  /** Entries of `evidence/manifest.json`, when it parsed. */
  readonly manifest?: readonly { readonly path: string; readonly sha256: string }[] | undefined;
  /** Case results: the case id and the spec the runner ran, when it ran one. */
  readonly results: readonly { readonly caseId: string; readonly spec?: string | undefined }[];
}

const CATEGORIES: readonly [string, TrailCategory][] = [
  ["ticket/", "ticket"],
  ["repos/", "change"],
  ["analysis.json", "context"],
  ["map/", "context"],
  ["knowledge/", "context"],
  ["plan/", "plan"],
  ["specs/", "tests"],
  ["results/", "runner"],
  ["logs/", "runner"],
  ["evidence/", "evidence"],
  ["checks/", "checks"],
  ["report/", "report"],
  [AGENT_TRANSCRIPT_FILE, "agents"],
  ["journal/", "journal"],
  ["explore/", "explore"],
  ["run.json", "run"],
];

/** The category of a run-relative path. */
export function trailCategory(path: string): TrailCategory {
  return CATEGORIES.find(([prefix]) => path === prefix || path.startsWith(prefix))?.[1] ?? "other";
}

const has = (files: ReadonlyMap<string, string>, prefix: string): boolean =>
  [...files.keys()].some((p) => p.startsWith(prefix));

/**
 * Computes the audit trail of a run (REQ-VER-16): every file with its SHA-256, grouped by what it is, and every gap
 * (AC4): a missing ticket snapshot, commit, plan, approval, generated test, version record, image digest,
 * environment, result, evidence file or report; evidence whose hash differs from the manifest; a broken journal; and
 * model calls whose prompts and answers are not stored. Hashes cover the stored files, which are masked before they
 * are written (AC3).
 *
 * @param input - The run's files, record and journals.
 * @returns The trail; `gaps` is empty only for a complete trail.
 */
export function buildAuditTrail(input: AuditTrailInput): AuditTrail {
  const { files, data } = input;
  const gaps: string[] = [];
  const items = [...files.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, sha256]) => ({ category: trailCategory(path), path, sha256 }));

  if (!files.has("ticket/ticket.json")) gaps.push("ticket snapshot ticket/ticket.json is missing");
  const repos = Object.entries(input.repos);
  if (repos.length === 0) gaps.push("no commit SHA recorded for the change");
  for (const [alias, r] of repos) {
    if (r.sha === undefined || r.sha === "") gaps.push(`repository ${alias}: no commit SHA recorded`);
    if (r.change === undefined || r.change === "")
      gaps.push(`repository ${alias}: no change reference recorded`);
  }

  if (!has(files, "plan/plan.v")) gaps.push("no plan version in plan/");
  const approval = data["approval"] as { sha256?: unknown; approver?: unknown } | undefined;
  const approved = files.get("plan/plan.approved.yaml");
  if (approved === undefined) gaps.push("plan/plan.approved.yaml is missing: the plan was never approved");
  else if (approval?.sha256 !== approved)
    gaps.push("plan/plan.approved.yaml does not have the SHA-256 recorded at approval");
  if (approved !== undefined && typeof approval?.approver !== "string")
    gaps.push("the approval (who, when, which version) is not recorded");

  if (input.results.length === 0) gaps.push("no case results: the run was not executed");
  for (const r of input.results) {
    if (r.spec === undefined) continue;
    const name = r.spec.split(/[\\/]/).at(-1) ?? "";
    if (!files.has(`specs/${name}`)) gaps.push(`${r.caseId}: generated test specs/${name} is missing`);
  }

  const versions = data["versions"];
  if (versions === null || typeof versions !== "object" || Object.keys(versions).length === 0)
    gaps.push("runner and tool versions are not recorded");
  const build = data["build"] as
    { services?: Record<string, { kind?: string }>; images?: readonly unknown[] } | undefined;
  const containers = Object.values(build?.services ?? {}).some(
    (s) => s.kind === "compose" || s.kind === "stub",
  );
  if (containers && (build?.images === undefined || build.images.length === 0))
    gaps.push("container image digests are not recorded");
  if (data["environment"] === undefined) gaps.push("the tested environment and its version are not recorded");

  if (input.manifest === undefined) gaps.push("evidence/manifest.json is missing or invalid");
  else {
    const listed = new Set<string>();
    for (const m of input.manifest) {
      const path = `evidence/${m.path}`;
      listed.add(path);
      const sha = files.get(path);
      if (sha === undefined) gaps.push(`evidence ${m.path} is missing`);
      else if (sha !== m.sha256) gaps.push(`evidence ${m.path} does not match its SHA-256 in the manifest`);
    }
    for (const path of files.keys())
      if (path.startsWith("evidence/") && path !== "evidence/manifest.json" && !listed.has(path))
        gaps.push(`${path} is not in the evidence manifest`);
  }
  const checks = (data["checks"] ?? {}) as Record<string, unknown>;
  for (const [name, sha] of Object.entries(checks))
    if (files.get(`checks/${name}`) !== sha) gaps.push(`checks/${name} does not match its recorded SHA-256`);

  for (const report of ["report/matrix.md", "report/report.html"])
    if (!files.has(report)) gaps.push(`${report} is missing`);

  if (input.events === undefined) gaps.push("journal/events.jsonl is missing");
  else {
    const anchor = data["journal"] as { lines: number; tail: string } | undefined;
    const journal = checkJournal(input.events, anchor);
    if (journal.legacy) gaps.push("journal/events.jsonl has no hash chain");
    gaps.push(...journal.problems.map((p) => `journal/events.jsonl ${p}`));
    gaps.push(...checkTranscript(input.events, input.transcript));
    if (approved !== undefined && typeof approval?.approver === "string") {
      const steps = Array.isArray(data["approvals"]) ? (data["approvals"] as ApprovalStep[]) : [];
      const check = checkApprovalRecords(
        approval as PlanApproval,
        steps,
        parseEventLines(input.events).events,
      );
      gaps.push(...check.problems.map((p) => `approval: ${p}`));
    }
  }
  return { items, gaps };
}
