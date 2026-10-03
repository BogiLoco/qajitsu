/**
 * `env` SecretProvider: resolves `secret://env/<NAME>` from the process environment and `.env.local`
 * (REQ-CFG-03/AC2). Values are never logged; the core resolver registers them with the masker.
 *
 * @packageDocumentation
 */
export { createEnvSecretProvider, parseDotenv } from "./env-secret-provider.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "secrets",
  name: "env",
  implements: "SecretProvider",
  roadmapStage: 1,
  requirements: ["REQ-CFG-03"],
  status: "implemented",
} as const;
