/**
 * Local EvidenceStore: files under `<run>/evidence/` and `evidence/manifest.json` with SHA-256 and size
 * per file (REQ-VER-05/AC1, invariant 7). Only runners write here, never agents (invariant 2).
 *
 * @packageDocumentation
 */
export { createLocalEvidenceStore, readManifest, MANIFEST_FILE } from "./local-store.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "evidence",
  name: "local",
  implements: "EvidenceStore",
  roadmapStage: 3,
  requirements: ["REQ-VER-05"],
  status: "implemented",
} as const;
