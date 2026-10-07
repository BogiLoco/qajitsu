import { createHash } from "node:crypto";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { ConfigError, GateFailedError } from "../errors.js";
import type { RunWorkspace } from "../workspace/run-workspace.js";
import { PlanSchema, type Plan, type PlanDraft, type SourceRef, type TestCase } from "./schemas.js";

/** File name of the frozen plan (invariant 3). */
export const APPROVED_PLAN_FILE = "plan.approved.yaml";

/** Approval record stored in `run.json` under `data.approval` (REQ-PLAN-06/AC1, REQ-PLAN-05/AC2). */
export interface PlanApproval {
  readonly version: number;
  readonly sha256: string;
  readonly approver: string;
  readonly at: string;
  readonly openQuestions: number;
  readonly openQuestionsConfirmed: boolean;
}

/**
 * SHA-256 of bytes, lowercase hex.
 *
 * @param content - Exact file content.
 */
export function sha256(content: string | Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

/**
 * Validates raw plan data (YAML already parsed) and returns readable issues.
 *
 * @throws {ConfigError} `PLAN_INVALID` with `context.issues`.
 */
export function parsePlan(raw: unknown, source = "plan"): Plan {
  const result = PlanSchema.safeParse(raw);
  if (result.success) return result.data;
  throw new ConfigError("PLAN_INVALID", `Invalid plan in ${source}`, {
    source,
    issues: result.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`),
  });
}

const versionOf = (file: string): number | undefined => {
  const m = /^plan\.v(\d+)\.yaml$/.exec(file);
  return m?.[1] ? Number(m[1]) : undefined;
};

/** Lists plan versions in a run, ascending. */
export async function listPlanVersions(ws: RunWorkspace): Promise<number[]> {
  const files = await readdir(ws.path("plan"));
  return files
    .map(versionOf)
    .filter((v): v is number => v !== undefined)
    .sort((a, b) => a - b);
}

/**
 * Reads plan version `n` (or the latest).
 *
 * @throws {ConfigError} `PLAN_NOT_FOUND` when the run has no such plan.
 */
export async function readPlan(
  ws: RunWorkspace,
  version?: number,
): Promise<{ plan: Plan; file: string; text: string }> {
  const versions = await listPlanVersions(ws);
  const n = version ?? versions.at(-1);
  if (n === undefined || !versions.includes(n)) {
    throw new ConfigError(
      "PLAN_NOT_FOUND",
      `Run ${ws.runId} has no plan${n === undefined ? "" : ` v${String(n)}`}.`,
      {
        run: ws.runId,
      },
    );
  }
  const file = ws.path("plan", `plan.v${String(n)}.yaml`);
  const text = await readFile(file, "utf8");
  return { plan: parsePlan(parse(text) as unknown, basename(file)), file, text };
}

const formatSource = (s: SourceRef): string => {
  switch (s.kind) {
    case "ac":
      return s.id;
    case "quote":
      return `"${s.text}"`;
    case "diff":
      return `${s.repo}:${s.file}${s.lines ? `#L${s.lines}` : ""}`;
    case "comment":
      return `${s.repo} review comment #${String(s.index)}`;
    case "observation":
      return `exploratory session ${s.session} ${s.id}`;
    case "imported":
      return `imported case ${s.id}`;
    case "doc": {
      const where = `${s.path ?? `doc ${s.chunk}`}${s.section ? ` › ${s.section}` : ""}`;
      const date = s.modified
        ? ` (${s.modified.slice(0, 10)}${s.outdated === true ? ", possibly outdated" : ""})`
        : "";
      return `${where}${date}: "${s.quote}"`;
    }
  }
};

/**
 * Renders a plan as Markdown for review (`plan.vN.md`).
 *
 * @param plan - Validated plan.
 */
export function renderPlanMarkdown(plan: Plan): string {
  const out = [`# Test plan ${plan.ticket} v${String(plan.version)}`, ""];
  if (plan.summary) out.push(plan.summary, "");
  if (plan.depth) out.push(`Depth: **${plan.depth}** (cases selected by priority; see Selection)`, "");
  out.push("| Id | Title | Type | Priority | Source |", "| --- | --- | --- | --- | --- |");
  for (const c of plan.cases) {
    out.push(
      `| ${c.id} | ${c.title.replaceAll("|", "\\|")} | ${c.type} | ${c.priority} | ${c.source.map(formatSource).join("; ").replaceAll("|", "\\|")} |`,
    );
  }
  for (const c of plan.cases) {
    out.push("", `## ${c.id}: ${c.title}`, "");
    if (c.reproduces)
      out.push(
        "_Reproduces the reported bug: must fail before the fix and pass with it (`qj run --fix-check`)._",
        "",
      );
    if (c.preconditions.length > 0) out.push(`Preconditions: ${c.preconditions.join("; ")}`, "");
    if (c.locales && c.locales.length > 0) out.push(`Also runs in locales: ${c.locales.join(", ")}`, "");
    const data = Object.entries(c.data);
    if (data.length > 0) out.push(`Data: ${data.map(([k, v]) => `${k}=${v}`).join(", ")}`, "");
    c.steps.forEach((s) => {
      const details = [
        s.expect.status === undefined ? undefined : `status ${String(s.expect.status)}`,
        s.expect.fields ? `fields ${JSON.stringify(s.expect.fields)}` : undefined,
        s.expect.texts ? `texts ${JSON.stringify(s.expect.texts)}` : undefined,
        s.expect.message ? `message ${JSON.stringify(s.expect.message)}` : undefined,
        s.expect.visual ? `visual ${JSON.stringify(s.expect.visual)}` : undefined,
        s.expect.by_locale ? `per locale ${JSON.stringify(s.expect.by_locale)}` : undefined,
      ].filter(Boolean);
      out.push(
        `1. **${s.id}**${s.manual === true ? " _(manual)_" : ""} ${s.action}  `,
        ...(s.manual === true && s.instructions ? [`   Tester: ${s.instructions}  `] : []),
        `   Expect: ${s.expect.description}${details.length > 0 ? ` (${details.join(", ")})` : ""}`,
      );
    });
    out.push("", `Evidence: ${c.evidence.join(", ")}`);
  }
  out.push("", "## Open questions", "");
  out.push(
    ...(plan.open_questions.length > 0
      ? plan.open_questions.map((q) => `- ${q.id}: ${q.question}`)
      : ["_(none)_"]),
  );
  if (plan.existing_coverage.length > 0) {
    out.push("", "## Already covered by existing tests", "");
    out.push(
      ...plan.existing_coverage.map((c) => `- ${c.covers.join(", ")}: "${c.title}" in ${c.repo}:${c.file}`),
    );
  }
  if (plan.selection.length > 0) {
    out.push("", "## Selection", "");
    out.push(
      ...plan.selection.map((x) => `- ${x.included ? "in" : "out"}: ${x.case} ${x.title} (${x.reason})`),
    );
  }
  out.push("", "## Out of scope", "");
  out.push(...(plan.out_of_scope.length > 0 ? plan.out_of_scope.map((o) => `- ${o}`) : ["_(none)_"]));
  return `${out.join("\n")}\n`;
}

/**
 * Writes the next plan version: `plan.vN.yaml` and `plan.vN.md` (REQ-PLAN-02/AC4).
 *
 * @param ws - Run workspace.
 * @param draft - Plan content from the planner or a manual edit.
 * @returns The stored plan with its version.
 */
export async function writePlanVersion(ws: RunWorkspace, draft: PlanDraft): Promise<Plan> {
  const version = ((await listPlanVersions(ws)).at(-1) ?? 0) + 1;
  const plan = parsePlan({ schema: 1, ticket: ws.ticket, version, ...draft });
  await writeFile(
    ws.path("plan", `plan.v${String(version)}.yaml`),
    stringify(plan, { lineWidth: 0 }),
    "utf8",
  );
  await writeFile(ws.path("plan", `plan.v${String(version)}.md`), renderPlanMarkdown(plan), "utf8");
  return plan;
}

/** Differences between two plan versions (REQ-PLAN-04/AC2). */
export interface PlanDiff {
  readonly added: readonly string[];
  readonly removed: readonly string[];
  readonly changed: readonly string[];
}

/** Compares cases of two plans by id. */
export function diffPlans(before: Plan, after: Plan): PlanDiff {
  const a = new Map(before.cases.map((c) => [c.id, c]));
  const b = new Map(after.cases.map((c) => [c.id, c]));
  const same = (x: TestCase, y: TestCase): boolean => JSON.stringify(x) === JSON.stringify(y);
  return {
    added: [...b.keys()].filter((id) => !a.has(id)),
    removed: [...a.keys()].filter((id) => !b.has(id)),
    changed: [...b.entries()]
      .filter(([id, c]) => {
        const before = a.get(id);
        return before !== undefined && !same(before, c);
      })
      .map(([id]) => id),
  };
}

/** Formats a plan diff for the terminal. */
export function formatPlanDiff(diff: PlanDiff): string {
  const parts = [
    ...diff.added.map((id) => `+ ${id}`),
    ...diff.removed.map((id) => `- ${id}`),
    ...diff.changed.map((id) => `~ ${id}`),
  ];
  return parts.length > 0 ? parts.join("\n") : "(no case changes)";
}

/**
 * Approves and freezes a plan version (REQ-PLAN-06/AC1, REQ-PLAN-05/AC2): writes `plan.approved.yaml`
 * with the exact bytes of the version, records SHA-256, approver and time in `run.json`.
 *
 * @throws {ConfigError} `PLAN_OPEN_QUESTIONS` when questions are open and not explicitly confirmed;
 *   `PLAN_ALREADY_APPROVED` when the run already has an approved plan.
 */
export async function approvePlan(
  ws: RunWorkspace,
  options: {
    readonly approver: string;
    readonly now: () => Date;
    readonly version?: number;
    readonly confirmOpenQuestions?: boolean;
  },
): Promise<PlanApproval> {
  if (ws.record.data["approval"] !== undefined) {
    throw new ConfigError(
      "PLAN_ALREADY_APPROVED",
      "This run already has an approved plan; start a new run to change it.",
      {
        run: ws.runId,
      },
    );
  }
  const { plan, text } = await readPlan(ws, options.version);
  const confirmed = options.confirmOpenQuestions === true;
  if (plan.open_questions.length > 0 && !confirmed) {
    throw new ConfigError(
      "PLAN_OPEN_QUESTIONS",
      `Plan v${String(plan.version)} has ${String(plan.open_questions.length)} open question(s); confirm explicitly to approve.`,
      { questions: plan.open_questions.map((q) => q.id) },
    );
  }
  await writeFile(ws.path("plan", APPROVED_PLAN_FILE), text, { encoding: "utf8", flag: "wx" });
  const approval: PlanApproval = {
    version: plan.version,
    sha256: sha256(text),
    approver: options.approver,
    at: options.now().toISOString(),
    openQuestions: plan.open_questions.length,
    openQuestionsConfirmed: confirmed,
  };
  await ws.update({
    stage: "approve",
    data: { ...ws.record.data, approval },
    checkpoints: [...ws.record.checkpoints, { stage: "approve", at: approval.at }],
  });
  return approval;
}

/**
 * Loads the approved plan and checks its hash against `run.json` (REQ-PLAN-06/AC3, invariant 3).
 *
 * @throws {GateFailedError} `PLAN_NOT_APPROVED` or `PLAN_HASH_MISMATCH`; the run must stop.
 */
export async function loadApprovedPlan(ws: RunWorkspace): Promise<{ plan: Plan; approval: PlanApproval }> {
  const approval = ws.record.data["approval"] as PlanApproval | undefined;
  if (approval === undefined || typeof approval.sha256 !== "string") {
    throw new GateFailedError("PLAN_NOT_APPROVED", "The plan of this run is not approved.", {
      run: ws.runId,
    });
  }
  let text: string;
  try {
    text = await readFile(ws.path("plan", APPROVED_PLAN_FILE), "utf8");
  } catch {
    throw new GateFailedError("PLAN_HASH_MISMATCH", "plan.approved.yaml is missing.", { run: ws.runId });
  }
  const actual = sha256(text);
  if (actual !== approval.sha256) {
    throw new GateFailedError(
      "PLAN_HASH_MISMATCH",
      "plan.approved.yaml changed after approval; the run is blocked.",
      {
        expected: approval.sha256,
        actual,
      },
    );
  }
  return { plan: parsePlan(parse(text) as unknown, APPROVED_PLAN_FILE), approval };
}

/**
 * Splits spec files into those that belong to approved cases and those that do not (REQ-PLAN-06/AC4).
 * Exactly one spec per case is executed: `<specsDir>/TC-01.spec.ts` (`.ts`, `.js`, `.mjs`). Anything
 * else (other names, nested folders, cases not in the plan) is rejected and reported, never executed.
 *
 * @param plan - Approved plan.
 * @param specFiles - Spec file paths.
 * @param specsDir - The run's `specs/` folder; when given, specs must sit directly in it.
 */
export function selectExecutableSpecs(
  plan: Plan,
  specFiles: readonly string[],
  specsDir?: string,
): { readonly execute: readonly string[]; readonly rejected: readonly string[] } {
  const ids = new Set(plan.cases.map((c) => c.id));
  const seen = new Set<string>();
  const execute: string[] = [];
  const rejected: string[] = [];
  for (const file of specFiles) {
    const id = /^(TC-\d{2,4})\.spec\.(?:ts|js|mjs)$/.exec(basename(file))?.[1];
    const placed = specsDir === undefined || resolve(dirname(file)) === resolve(specsDir);
    if (id !== undefined && ids.has(id) && placed && !seen.has(id)) {
      seen.add(id);
      execute.push(file);
    } else {
      rejected.push(file);
    }
  }
  return { execute, rejected };
}
