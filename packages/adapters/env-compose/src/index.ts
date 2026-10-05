/**
 * `--build` environment: the project's Docker Compose file plus a generated overlay (labels, dynamic
 * localhost ports, env files), managed processes, stubs, health checks and the seed hook
 * (REQ-ENV-03, REQ-ENV-04, REQ-ENV-05, REQ-CFG-05, REQ-WS-02).
 *
 * @packageDocumentation
 */
export {
  startBuildEnvironment,
  createComposeEnvProvider,
  writeEnvFiles,
  endpointsFor,
  BuildStartError,
  execCommand,
  freePort,
  labelsFor,
  projectName,
  type BuildEnvironment,
  type ComposeEnvProvider,
  type BuildOptions,
  type CommandExec,
} from "./build.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "env",
  name: "compose",
  implements: "EnvProvider",
  roadmapStage: 6,
  requirements: ["REQ-ENV-03", "REQ-ENV-04", "REQ-ENV-05", "REQ-WS-02"],
  status: "implemented",
} as const;
export { removeRunResources, type RemovedResources } from "./cleanup.js";
