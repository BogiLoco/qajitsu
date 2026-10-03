import { z } from "zod";
import { ConfigError } from "../errors.js";

const SecretRef = z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Expected a secret:// reference");

const CodeHostSchema = z.strictObject({
  type: z.enum(["github", "gitlab"]),
  base_url: z.url().optional(),
  token: SecretRef,
});

const RepoSchema = z.strictObject({
  host: z.string().min(1),
  path: z.string().regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "Expected owner/name or group/subgroup/name"),
  default_ref: z.string().min(1).default("main"),
  role: z.enum(["app", "tests"]).default("app"),
});

/**
 * Schema of `.qa/qa.project.yaml` (REQ-GEN-01). This is the stage-1 subset; later stages extend it
 * (services and env templates REQ-CFG-02, cleanup REQ-WS-03, publish options REQ-PUB-*).
 */
export const ProjectConfigSchema = z.strictObject({
  project: z.string().regex(/^[a-z][a-z0-9-]*$/, "Use a lowercase project slug"),
  jira: z.strictObject({
    project_key: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
    acceptance_criteria_field: z.string().optional(),
  }),
  code_hosts: z.record(z.string(), CodeHostSchema).default({}),
  repos: z.record(z.string(), RepoSchema).default({}),
  change_discovery: z
    .array(z.enum(["jira_dev_panel", "ticket_key_in_branch", "ticket_key_in_title"]))
    .default(["jira_dev_panel", "ticket_key_in_branch", "ticket_key_in_title"]),
  environments: z
    .strictObject({
      default: z.string().optional(),
      version_endpoint: z.string().startsWith("/").optional(),
      allowlist: z.array(z.string()).default([]),
    })
    .default({ allowlist: [] }),
  models: z
    .strictObject({
      roles: z.record(z.string(), z.string()).default({}),
    })
    .default({ roles: {} }),
  test_types: z
    .array(z.enum(["api", "web", "mobile"]))
    .min(1)
    .default(["api"]),
});

/** Parsed and defaulted project configuration. */
export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

/**
 * Validates raw project configuration (already parsed from YAML).
 *
 * @param raw - Untrusted configuration object.
 * @param source - Where it came from, for error messages.
 * @returns The validated configuration with defaults applied.
 * @throws {ConfigError} `CONFIG_INVALID` with every problem listed in `context.issues`.
 * @example
 * const config = parseProjectConfig(yaml.parse(text), ".qa/qa.project.yaml");
 */
export function parseProjectConfig(raw: unknown, source = ".qa/qa.project.yaml"): ProjectConfig {
  const result = ProjectConfigSchema.safeParse(raw);
  if (result.success) {
    const missingHosts = Object.entries(result.data.repos)
      .filter(([, repo]) => !(repo.host in result.data.code_hosts))
      .map(([alias, repo]) => `repos.${alias}.host: unknown code host '${repo.host}'`);
    if (missingHosts.length === 0) return result.data;
    throw new ConfigError("CONFIG_INVALID", `Invalid configuration in ${source}`, {
      source,
      issues: missingHosts,
    });
  }
  const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new ConfigError("CONFIG_INVALID", `Invalid configuration in ${source}`, { source, issues });
}
