/**
 * Web Runner: the trusted parent drives a Playwright browser for sandboxed specs, with a screenshot per
 * step, video and trace on failure, console log and HAR per case (REQ-EXEC-05, REQ-EVD-02, ADR-0004).
 *
 * @packageDocumentation
 */
export {
  browserUnavailable,
  createPlaywrightBrowserFactory,
  locate,
  maskHar,
  type WebRunnerOptions,
} from "./browser.js";
export { compareImages } from "./visual.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "runner",
  name: "web",
  implements: "AttemptExecutor",
  roadmapStage: 5,
  requirements: ["REQ-EXEC-05", "REQ-EVD-02", "REQ-EVD-06"],
  status: "implemented",
} as const;
