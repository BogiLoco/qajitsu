/**
 * Remote EnvProvider (`--env <profile|url>`): allowlist check, health check, deployed version check.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "env",
  name: "remote",
  implements: "EnvProvider",
  roadmapStage: 3,
  requirements: ["REQ-ENV-01", "REQ-ENV-02", "REQ-ENV-07"],
  status: "planned",
} as const;
