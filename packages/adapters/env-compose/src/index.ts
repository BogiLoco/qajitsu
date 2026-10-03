/**
 * Docker Compose EnvProvider (`--build`): generated overlay, dynamic ports, labels, health checks, seeding, cleanup.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "env",
  name: "compose",
  implements: "EnvProvider",
  roadmapStage: 6,
  requirements: ["REQ-ENV-03", "REQ-ENV-04", "REQ-ENV-05", "REQ-WS-02"],
  status: "planned",
} as const;
