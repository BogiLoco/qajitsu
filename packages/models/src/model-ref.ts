import { ConfigError } from "@qajitsu/core";
import { z } from "zod";

/** Agent roles that need a model (REQ-LLM-02). */
export const MODEL_ROLES = ["analyst", "planner", "author", "healer", "auditor", "summary"] as const;

/** A role that is assigned a model in `models.roles`. */
export type ModelRole = (typeof MODEL_ROLES)[number];

/**
 * Reference `<provider>/<model>` as written in `models.roles`, e.g. `anthropic/claude-sonnet-5`,
 * `company/strong` (a LiteLLM alias) or `local/qwen2.5-coder:32b` (Ollama). The model part may
 * contain `/` and `:`.
 */
export const ModelRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*\/\S+$/, "Expected <provider>/<model>, e.g. company/strong");

/** Parsed model reference. */
export interface ModelRef {
  readonly provider: string;
  readonly model: string;
}

/**
 * Parses a model reference.
 *
 * @throws {ConfigError} `MODEL_REF_INVALID` when the reference is malformed.
 */
export function parseModelRef(reference: string): ModelRef {
  const parsed = ModelRefSchema.safeParse(reference);
  if (!parsed.success) {
    throw new ConfigError("MODEL_REF_INVALID", `Invalid model reference '${reference}'`, { reference });
  }
  const slash = parsed.data.indexOf("/");
  return { provider: parsed.data.slice(0, slash), model: parsed.data.slice(slash + 1) };
}

/**
 * Resolves the model for a role from `models.roles`, falling back to the `default` entry.
 *
 * @throws {ConfigError} `MODEL_ROLE_UNASSIGNED` when neither the role nor `default` is configured.
 */
export function resolveRoleModel(roles: Readonly<Record<string, string>>, role: ModelRole): ModelRef {
  const reference = roles[role] ?? roles["default"];
  if (reference === undefined) {
    throw new ConfigError("MODEL_ROLE_UNASSIGNED", `No model configured for role '${role}' and no default`, {
      role,
    });
  }
  return parseModelRef(reference);
}
