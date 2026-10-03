/**
 * `secret://env/<NAME>` SecretProvider backed by process environment and `.env.local`.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "secrets",
  name: "env",
  implements: "SecretProvider",
  roadmapStage: 1,
  requirements: ["REQ-CFG-03", "REQ-CFG-06"],
  status: "planned",
} as const;
