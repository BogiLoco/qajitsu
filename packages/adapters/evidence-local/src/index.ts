/**
 * Local EvidenceStore: writes evidence under `evidence/` and maintains `evidence/manifest.json`.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "evidence",
  name: "local",
  implements: "EvidenceStore",
  roadmapStage: 3,
  requirements: ["REQ-VER-05", "REQ-WS-01"],
  status: "planned",
} as const;
