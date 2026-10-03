/**
 * Web Runner: Playwright Test with a screenshot per step, video and trace on failure, console and HAR.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "runner",
  name: "web",
  implements: "Runner",
  roadmapStage: 5,
  requirements: ["REQ-EXEC-05", "REQ-EVD-02"],
  status: "planned",
} as const;
