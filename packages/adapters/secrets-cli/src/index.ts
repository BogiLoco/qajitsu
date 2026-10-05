/**
 * Secret managers through their official CLIs (REQ-CFG-03/AC3): 1Password (`op`), AWS Secrets Manager (`aws`) and
 * Google Secret Manager (`gcloud`). Commands run with argument arrays and only the CLI's own environment variables;
 * values are never logged and the core resolver registers them with the masker.
 *
 * @packageDocumentation
 */
export {
  createAwsSecretProvider,
  createGcpSecretProvider,
  createOnePasswordSecretProvider,
  type SecretCliExec,
  type SecretCliOptions,
} from "./cli-providers.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "secrets",
  name: "cli",
  implements: "SecretProvider",
  roadmapStage: 1,
  requirements: ["REQ-CFG-03"],
  status: "implemented",
} as const;
