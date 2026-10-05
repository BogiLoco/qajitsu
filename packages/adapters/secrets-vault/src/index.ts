/**
 * `vault` SecretProvider: resolves `secret://vault/<path>#<field>` from HashiCorp Vault KV v2 (REQ-CFG-03/AC3).
 * Values are never logged; the core resolver registers them with the masker.
 *
 * @packageDocumentation
 */
export { createVaultSecretProvider, type VaultOptions } from "./vault.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "secrets",
  name: "vault",
  implements: "SecretProvider",
  roadmapStage: 1,
  requirements: ["REQ-CFG-03"],
  status: "implemented",
} as const;
