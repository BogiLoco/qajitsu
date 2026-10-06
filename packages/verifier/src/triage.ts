import type { CaseResultFile, TriageHint } from "@qajitsu/core";

/** What hints may cite: the run's results, evidence manifest and log files (REQ-VER-12/AC2). */
export interface TriageEvidence {
  readonly results: ReadonlyMap<string, CaseResultFile>;
  /** Evidence paths in the manifest. */
  readonly manifest: readonly string[];
  /** Log files of the run, relative to `logs/`. */
  readonly logs: readonly string[];
  /** Cases with status FAILED, computed by code. */
  readonly failed: readonly string[];
}

/** Whether a citation points at something that exists for this case. */
function exists(caseId: string, cite: TriageHint["cites"][number], evidence: TriageEvidence): boolean {
  const attempts = evidence.results.get(caseId)?.attempts ?? [];
  switch (cite.kind) {
    case "step":
      return attempts.some((a) => a.steps.some((s) => s.id === cite.ref));
    case "assertion":
      return attempts.some((a) => a.assertions.some((x) => `${x.stepId}.${x.field}` === cite.ref));
    case "evidence":
      return cite.ref.startsWith(`${caseId}/`) && evidence.manifest.includes(cite.ref);
    case "log":
      return evidence.logs.includes(cite.ref);
  }
}

/**
 * Keeps triage hints only for FAILED cases, one per case, with only the citations that exist; a hint with no real
 * citation left is dropped (REQ-VER-12/AC1+AC2). Hints never reach status computation (invariant 1).
 *
 * @returns Kept hints and the case ids whose hint was dropped.
 */
export function checkTriageHints(
  hints: readonly TriageHint[],
  evidence: TriageEvidence,
): { hints: TriageHint[]; dropped: string[] } {
  const kept: TriageHint[] = [];
  const dropped: string[] = [];
  for (const hint of hints) {
    if (kept.some((k) => k.caseId === hint.caseId)) continue;
    const cites = evidence.failed.includes(hint.caseId)
      ? hint.cites.filter((c) => exists(hint.caseId, c, evidence))
      : [];
    if (cites.length === 0) {
      if (!dropped.includes(hint.caseId)) dropped.push(hint.caseId);
      continue;
    }
    kept.push({ ...hint, cites });
  }
  return { hints: kept, dropped };
}
