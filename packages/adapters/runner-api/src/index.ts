/**
 * API Runner: executes generated API specs with Playwright Test, records request/response evidence.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "runner",
  name: "api",
  implements: "Runner",
  roadmapStage: 3,
  requirements: ["REQ-EXEC-04", "REQ-EVD-01"],
  status: "planned",
} as const;
