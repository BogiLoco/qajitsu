/**
 * Mobile Runner: WebdriverIO + Appium with a screenshot per step, screen recording and device logs.
 * Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "runner",
  name: "mobile",
  implements: "Runner",
  roadmapStage: 8,
  requirements: ["REQ-EXEC-06", "REQ-EVD-03", "REQ-ENV-06"],
  status: "planned",
} as const;
