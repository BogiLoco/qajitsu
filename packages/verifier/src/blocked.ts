import type { BlockedHint, CaseResultFile } from "@qajitsu/core";

/** What BLOCKED hints may cite (REQ-VER-13/AC2). */
export interface BlockedEvidence {
  readonly results: ReadonlyMap<string, CaseResultFile>;
  /** Evidence paths in the manifest. */
  readonly manifest: readonly string[];
  /** Log files of the run, relative to `logs/`. */
  readonly logs: readonly string[];
  /** Spec source per case, when the case has one. */
  readonly specs: Readonly<Record<string, string>>;
  /** Cases with status BLOCKED, computed by code. */
  readonly blocked: readonly string[];
}

/** Whether a citation points at something that exists for this case. */
function exists(caseId: string, cite: BlockedHint["cites"][number], evidence: BlockedEvidence): boolean {
  const attempts = evidence.results.get(caseId)?.attempts ?? [];
  switch (cite.kind) {
    case "step":
      return attempts.some((a) => a.steps.some((s) => s.id === cite.ref));
    case "evidence":
      return cite.ref.startsWith(`${caseId}/`) && evidence.manifest.includes(cite.ref);
    case "log":
      return evidence.logs.includes(cite.ref);
    case "spec": {
      const lines = evidence.specs[caseId]?.split("\n").length ?? 0;
      return /^\d+$/.test(cite.ref) && Number(cite.ref) >= 1 && Number(cite.ref) <= lines;
    }
    case "error":
      return cite.ref === "error" && attempts.some((a) => a.error !== undefined);
  }
}

/**
 * Keeps hints only for BLOCKED cases, one per case, with only the citations that exist; a hint with no real citation
 * left is dropped (REQ-VER-13/AC2). Hints never reach status computation (invariant 1).
 *
 * @returns Kept hints and the case ids whose hint was dropped.
 */
export function checkBlockedHints(
  hints: readonly BlockedHint[],
  evidence: BlockedEvidence,
): { hints: BlockedHint[]; dropped: string[] } {
  const kept: BlockedHint[] = [];
  const dropped: string[] = [];
  for (const hint of hints) {
    if (kept.some((k) => k.caseId === hint.caseId)) continue;
    const cites = evidence.blocked.includes(hint.caseId)
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
