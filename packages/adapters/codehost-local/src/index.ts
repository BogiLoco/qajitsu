/**
 * Local CodeHost: git repositories in a directory, for the demo-shop and offline runs (REQ-NFR-04).
 *
 * @packageDocumentation
 */
export { createLocalCodeHost } from "./local.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "codehost",
  name: "local",
  implements: "CodeHost",
  roadmapStage: 1,
  requirements: ["REQ-NFR-04", "REQ-CTX-03"],
  status: "implemented",
} as const;
