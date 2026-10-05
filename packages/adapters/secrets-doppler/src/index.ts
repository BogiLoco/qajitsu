/**
 * `doppler` SecretProvider: resolves `secret://doppler/<NAME>` from a Doppler project config (REQ-CFG-03/AC3).
 * Values are never logged; the core resolver registers them with the masker.
 *
 * @packageDocumentation
 */
export { createDopplerSecretProvider, type DopplerOptions } from "./doppler.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "secrets",
  name: "doppler",
  implements: "SecretProvider",
  roadmapStage: 1,
  requirements: ["REQ-CFG-03"],
  status: "implemented",
} as const;
