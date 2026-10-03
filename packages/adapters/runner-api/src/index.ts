/**
 * API Runner: executes generated specs in a sandboxed Node process on Playwright `APIRequestContext`,
 * with retries, evidence per call and `results/<case>.json` (REQ-EXEC-04, REQ-EXEC-08, REQ-EVD-01).
 *
 * @packageDocumentation
 */
export { executeAttempt, type AttemptInput } from "./attempt.js";
export { createSandboxExecutor, sandboxFlags, type AttemptExecutor } from "./sandbox.js";
export { applyContract, runCases, type RunCasesOptions } from "./run-cases.js";
export { createContractValidator, loadContractValidator, type ContractValidator } from "./openapi.js";
export { createPlaywrightTransport } from "./transport.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "runner",
  name: "api",
  implements: "Runner",
  roadmapStage: 3,
  requirements: ["REQ-EXEC-04", "REQ-EXEC-08", "REQ-EVD-01"],
  status: "implemented",
} as const;
