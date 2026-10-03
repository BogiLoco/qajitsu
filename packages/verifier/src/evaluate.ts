import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { AssertionRecord, CaseResultFile, EvidenceEntry, Plan, TestStatus } from "@qajitsu/core";
import { computeStatus } from "./compute-status.js";
import {
  combineGates,
  gateApprovedPlanUnchanged,
  gateEveryApprovedCaseHasOneStatus,
  type GateResult,
} from "./gates.js";

/** Problems with evidence files against the manifest (REQ-VER-05/AC2). */
export interface ManifestCheck {
  /** Manifest paths whose file is missing or whose hash or size differs. */
  readonly broken: ReadonlySet<string>;
  readonly problems: readonly string[];
}

/**
 * Re-hashes every evidence file listed in the manifest (invariant 7).
 *
 * @param evidenceDir - The run's `evidence/` folder.
 * @param manifest - Entries of `evidence/manifest.json`.
 */
export async function checkManifest(
  evidenceDir: string,
  manifest: readonly EvidenceEntry[],
): Promise<ManifestCheck> {
  const broken = new Set<string>();
  const problems: string[] = [];
  for (const entry of manifest) {
    let content: Buffer;
    try {
      content = await readFile(join(evidenceDir, entry.path));
    } catch {
      broken.add(entry.path);
      problems.push(`${entry.path}: listed in the manifest but missing`);
      continue;
    }
    const sha = createHash("sha256").update(content).digest("hex");
    if (sha !== entry.sha256 || content.byteLength !== entry.bytes) {
      broken.add(entry.path);
      problems.push(`${entry.path}: hash or size differs from the manifest`);
    }
  }
  return { broken, problems };
}

/** The evaluated outcome of one approved case. */
export interface CaseEvaluation {
  readonly caseId: string;
  readonly status: TestStatus;
  readonly stepsPassed: number;
  readonly stepsTotal: number;
  /** Every plan step of the first attempt has intact evidence. */
  readonly evidenceComplete: boolean;
  readonly attempts: number;
  /** Failed assertions of the last attempt, with expected and actual (REQ-VER-07/AC4). */
  readonly failures: readonly AssertionRecord[];
  readonly error?: string;
  /** Evidence entries of the last attempt. */
  readonly evidence: readonly EvidenceEntry[];
}

type Attempt = CaseResultFile["attempts"][number];

const attemptEvidence = (
  attempt: Attempt | undefined,
  caseId: string,
  manifest: readonly EvidenceEntry[],
): EvidenceEntry[] =>
  attempt === undefined
    ? []
    : manifest.filter((m) => m.caseId === caseId && attempt.evidence.includes(m.path));

const evidenceForEveryStep = (
  stepIds: readonly string[],
  entries: readonly EvidenceEntry[],
  broken: ReadonlySet<string>,
): boolean => stepIds.every((id) => entries.some((e) => e.stepId === id && !broken.has(e.path)));

/**
 * Computes the status of every approved case from runner results and evidence (REQ-VER-02, invariant 1).
 * A case without a results file is NOT_RUN; results for cases outside the plan are ignored here and
 * caught by the publish gate.
 *
 * @param plan - Approved plan.
 * @param results - `results/<case>.json` contents by case id.
 * @param manifest - Evidence manifest.
 * @param manifestCheck - Result of {@link checkManifest}.
 */
export function evaluateCases(
  plan: Plan,
  results: ReadonlyMap<string, CaseResultFile>,
  manifest: readonly EvidenceEntry[],
  manifestCheck: ManifestCheck,
): CaseEvaluation[] {
  return plan.cases.map((planCase) => {
    const stepIds = planCase.steps.map((s) => s.id);
    const result = results.get(planCase.id);
    const attempts = result?.attempts ?? [];
    const first = attempts[0];
    const last = attempts.at(-1);
    // PASSED needs, for every plan step, intact evidence and at least one assertion (REQ-VER-07/AC3).
    const evidenceComplete =
      evidenceForEveryStep(stepIds, attemptEvidence(first, planCase.id, manifest), manifestCheck.broken) &&
      stepIds.every((id) => first?.assertions.some((a) => a.stepId === id) === true);
    const status = computeStatus({ caseId: planCase.id, attempts }, { evidenceComplete });
    const stepsPassed = stepIds.filter((id) => {
      const a = last?.assertions.filter((x) => x.stepId === id) ?? [];
      return a.length > 0 && a.every((x) => x.pass) && (last?.steps.find((s) => s.id === id)?.ok ?? true);
    }).length;
    return {
      caseId: planCase.id,
      status,
      stepsPassed,
      stepsTotal: stepIds.length,
      evidenceComplete,
      attempts: attempts.length,
      failures: last?.assertions.filter((a) => !a.pass) ?? [],
      ...(last?.error === undefined ? {} : { error: last.error }),
      evidence: attemptEvidence(last, planCase.id, manifest),
    };
  });
}

/** Every PASSED has at least one executed `verify()` and evidence for every step (REQ-VER-07/AC3). */
export function gatePassedIsProven(
  plan: Plan,
  cases: readonly CaseEvaluation[],
  results: ReadonlyMap<string, CaseResultFile>,
  manifest: readonly EvidenceEntry[],
  manifestCheck: ManifestCheck,
): GateResult {
  const problems: string[] = [];
  for (const c of cases.filter((x) => x.status === "PASSED")) {
    const first = results.get(c.caseId)?.attempts[0];
    if (!first || first.assertions.length === 0)
      problems.push(`${c.caseId}: PASSED without an executed verify()`);
    const entries = attemptEvidence(first, c.caseId, manifest);
    for (const step of plan.cases.find((p) => p.id === c.caseId)?.steps ?? []) {
      if (!evidenceForEveryStep([step.id], entries, manifestCheck.broken))
        problems.push(`${c.caseId}: PASSED without evidence for ${step.id}`);
      if (first && first.assertions.length > 0 && !first.assertions.some((a) => a.stepId === step.id)) {
        problems.push(`${c.caseId}: PASSED without a verify() for ${step.id}`);
      }
    }
  }
  return { gate: "passed-is-proven", ok: problems.length === 0, problems };
}

/** Every FAILED records expected and actual values and evidence of the failing step (REQ-VER-07/AC4). */
export function gateFailedIsExplained(cases: readonly CaseEvaluation[]): GateResult {
  const problems: string[] = [];
  for (const c of cases.filter((x) => x.status === "FAILED")) {
    if (c.failures.length === 0) {
      problems.push(`${c.caseId}: FAILED without a failed assertion`);
      continue;
    }
    for (const f of c.failures) {
      if (f.expected === undefined || f.actual === undefined)
        problems.push(`${c.caseId}.${f.stepId}.${f.field}: FAILED without expected and actual values`);
      if (!c.evidence.some((e) => e.stepId === f.stepId))
        problems.push(`${c.caseId}.${f.stepId}: FAILED without evidence of the failing step`);
    }
  }
  return { gate: "failed-is-explained", ok: problems.length === 0, problems };
}

/** All manifest files exist with matching hashes (REQ-VER-07/AC5). */
export function gateManifestIntact(check: ManifestCheck): GateResult {
  return { gate: "manifest-intact", ok: check.problems.length === 0, problems: check.problems };
}

/** No outgoing artifact contains a registered secret value (REQ-VER-07/AC6, REQ-CFG-06/AC3). */
export function gateNoSecrets(
  artifacts: readonly { readonly name: string; readonly text: string }[],
  containsSecret: (text: string) => boolean,
): GateResult {
  const problems = artifacts
    .filter((a) => containsSecret(a.text))
    .map((a) => `${a.name}: contains a secret value`);
  return { gate: "no-secrets", ok: problems.length === 0, problems };
}

/** Everything needed to decide whether results may be published. */
export interface RunVerdictInput {
  readonly plan: Plan;
  readonly results: ReadonlyMap<string, CaseResultFile>;
  /** Case ids that have a results file, including ones outside the plan (REQ-VER-07/AC1). */
  readonly reportedCaseIds: readonly string[];
  readonly manifest: readonly EvidenceEntry[];
  readonly manifestCheck: ManifestCheck;
  readonly approvedSha256: string;
  readonly currentSha256: string;
}

/**
 * Evaluates a run: statuses per case plus the publish gates that do not depend on rendered artifacts.
 * The secret scan runs separately over the rendered reports ({@link gateNoSecrets}).
 */
export function evaluateRun(input: RunVerdictInput): { cases: CaseEvaluation[]; gates: GateResult[] } {
  const cases = evaluateCases(input.plan, input.results, input.manifest, input.manifestCheck);
  const reported = [
    ...cases.map((c) => ({ caseId: c.caseId, status: c.status })),
    ...input.reportedCaseIds
      .filter((id) => !cases.some((c) => c.caseId === id))
      .map((caseId) => ({ caseId, status: "NOT_RUN" as const })),
  ];
  const gates = [
    gateEveryApprovedCaseHasOneStatus(
      input.plan.cases.map((c) => c.id),
      reported,
    ),
    gateApprovedPlanUnchanged(input.approvedSha256, input.currentSha256),
    gatePassedIsProven(input.plan, cases, input.results, input.manifest, input.manifestCheck),
    gateFailedIsExplained(cases),
    gateManifestIntact(input.manifestCheck),
  ];
  return { cases, gates };
}

export { combineGates };
