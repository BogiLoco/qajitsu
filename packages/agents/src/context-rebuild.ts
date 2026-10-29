import { createHash } from "node:crypto";
import {
  ContextSnapshotSchema,
  snapshotHash,
  type ContextFragment,
  type ContextSnapshot,
} from "@qajitsu/core";
import { CONTEXT_RENDERER, renderFragments } from "./context-manager.js";
import { handleOf, trimmed } from "./context-reduce.js";

/** How one fragment of a recorded call compares with the run's files (REQ-CTX-17/AC4). */
export interface RebuiltFragment {
  readonly kind: string;
  readonly source: string;
  readonly sha256: string;
  /** `missing`: no text with this hash in the run; `changed`: the text, or its reduction, no longer gives the record. */
  readonly status: "same" | "missing" | "changed";
}

/** A recorded call rebuilt from its snapshot. */
export interface RebuiltCall {
  readonly stage: string;
  readonly role: string;
  /** The snapshot's own hash still matches its content. */
  readonly snapshotIntact: boolean;
  /** The renderer of the record is the one of this version, so the rebuilt text is what was sent. */
  readonly sameRenderer: boolean;
  readonly fragments: readonly RebuiltFragment[];
  /** The rebuilt input, when every fragment is the same. */
  readonly input?: { readonly system: string; readonly prompt: string; readonly sha256: string };
}

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/**
 * Rebuilds the input of a recorded call from its snapshot and the fragment texts the run kept (REQ-CTX-17/AC4): every
 * fragment is read by its hash and checked; trimming is applied again by code; the input is rendered with the run's
 * marker. Differences are reported by fragment.
 *
 * @param recorded - The `context.snapshot` journal entry's details.
 * @param readText - The text the run kept for a hash, or undefined.
 */
export function rebuildCall(
  recorded: unknown,
  readText: (sha256: string) => string | undefined,
): RebuiltCall {
  const snapshot: ContextSnapshot = ContextSnapshotSchema.parse(recorded);
  const { sha256: recordedHash, ...unsigned } = snapshot;
  const trimmedAway = new Set(snapshot.reductions.filter((r) => r.action === "trimmed").map((r) => r.sha256));
  const shown: ContextFragment[] = [];
  const fragments = snapshot.fragments.map((f): RebuiltFragment => {
    const base = { kind: f.kind, source: f.source, sha256: f.sha256 };
    const text = readText(f.sha256);
    if (text === undefined) return { ...base, status: "missing" };
    if (sha(text) !== f.sha256) return { ...base, status: "changed" };
    const full: ContextFragment = { ...f, text, tokens: Math.ceil(text.length / 4) };
    const cut = trimmedAway.has(f.sha256) ? trimmed(full, handleOf(full)) : undefined;
    const rebuilt = cut === undefined ? full : { ...full, text: cut, tokens: Math.ceil(cut.length / 4) };
    // The recorded size is checked too: a trimming rule that changed would give another text.
    if (rebuilt.tokens !== f.tokens) return { ...base, status: "changed" };
    shown.push(rebuilt);
    return { ...base, status: "same" };
  });
  const complete = fragments.every((f) => f.status === "same");
  const input = complete ? renderFragments(snapshot.marker, shown) : undefined;
  return {
    stage: snapshot.stage,
    role: snapshot.role,
    snapshotIntact: snapshotHash(unsigned) === recordedHash,
    sameRenderer: snapshot.renderer === CONTEXT_RENDERER,
    fragments,
    ...(input ? { input: { ...input, sha256: sha(`${input.system}\n\n${input.prompt}`) } } : {}),
  };
}
