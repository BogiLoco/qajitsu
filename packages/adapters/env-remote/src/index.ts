/**
 * Provided environment (`--env`): health check, deployed version and framework login of account
 * aliases (REQ-ENV-01, REQ-ENV-02, REQ-CFG-07).
 *
 * @packageDocumentation
 */
export {
  checkHealth,
  readDeployedSha,
  loginAccounts,
  compareDeployedSha,
  createRemoteEnvProvider,
  type ScriptRunner,
} from "./remote.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "env",
  name: "remote",
  implements: "EnvProvider",
  roadmapStage: 3,
  requirements: ["REQ-ENV-01", "REQ-ENV-02", "REQ-CFG-07"],
  status: "implemented",
} as const;
