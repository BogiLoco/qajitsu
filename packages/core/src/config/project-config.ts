import { z } from "zod";
import { ConfigError } from "../errors.js";

const SecretRef = z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Expected a secret:// reference");

/** Alias used as a folder name (repos/<alias>, git cache/<host>): no dots, slashes or leading dashes. */
const Alias = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_-]{0,39}$/, "Use a lowercase alias: letters, digits, - and _");

/** Capabilities that can be declared per model when the built-in profile is wrong or missing (REQ-LLM-03). */
const CapabilityOverrideSchema = z.strictObject({
  tools: z.boolean().optional(),
  structured_output: z.boolean().optional(),
  vision: z.boolean().optional(),
  context_window: z.number().int().positive().optional(),
  /** USD per million input and output tokens, for cost estimates (REQ-LLM-07). */
  cost_per_mtok: z
    .strictObject({ input: z.number().nonnegative(), output: z.number().nonnegative() })
    .optional(),
});

const ModelProviderSchema = z
  .strictObject({
    type: z.enum(["anthropic", "openai", "google", "ollama", "openai-compatible"]),
    base_url: z.url().optional(),
    api_key: SecretRef.optional(),
    /** Overrides keyed by model id, e.g. `qwen3:32b`. */
    models: z.record(z.string(), CapabilityOverrideSchema).default({}),
  })
  .superRefine((p, ctx) => {
    if (p.type === "openai-compatible" && p.base_url === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["base_url"],
        message: "Required for openai-compatible providers",
      });
    }
    if (["anthropic", "openai", "google"].includes(p.type) && p.api_key === undefined) {
      ctx.addIssue({ code: "custom", path: ["api_key"], message: `Required for ${p.type}` });
    }
  });

const IdSchema = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);

const CodeHostSchema = z
  .strictObject({
    /** `local` serves git repositories from a directory (demo-shop, offline runs, e2e tests). */
    type: z.enum(["github", "gitlab", "local"]),
    /** Directory with `<path>` repositories for `type: local`; `~/` and paths relative to `.qa/` allowed. */
    root: z.string().min(1).optional(),
    /** Web URL of a self-hosted instance (GitHub Enterprise Server, GitLab self-managed). */
    base_url: z.url().optional(),
    /** GitHub fine-grained token or GitLab project/group access token (REQ-CTX-02/AC3). */
    token: SecretRef.optional(),
    /** GitHub App installation, as an alternative to a token (REQ-CTX-02/AC3). */
    app: z.strictObject({ app_id: IdSchema, installation_id: IdSchema, private_key: SecretRef }).optional(),
  })
  .superRefine((host, ctx) => {
    if (host.type === "local") {
      if (host.root === undefined)
        ctx.addIssue({ code: "custom", path: ["root"], message: "Required when type is 'local'" });
      if (host.token !== undefined || host.app !== undefined) {
        ctx.addIssue({ code: "custom", path: ["token"], message: "A local code host takes no credentials" });
      }
      return;
    }
    if (host.root !== undefined) {
      ctx.addIssue({ code: "custom", path: ["root"], message: "root is only valid for type local" });
    }
    if ((host.token === undefined) === (host.app === undefined)) {
      ctx.addIssue({ code: "custom", path: ["token"], message: "Set exactly one of token or app" });
    }
    if (host.app !== undefined && host.type !== "github") {
      ctx.addIssue({
        code: "custom",
        path: ["app"],
        message: "GitHub App auth is only valid for type github",
      });
    }
  });

const RepoSchema = z.strictObject({
  host: z.string().min(1),
  path: z.string().regex(/^[\w.-]+(?:\/[\w.-]+)+$/, "Expected owner/name or group/subgroup/name"),
  default_ref: z.string().min(1).default("main"),
  role: z.enum(["app", "tests"]).default("app"),
  /** OpenAPI document inside the repository; API responses are validated against it (REQ-EXEC-04/AC2). */
  openapi: z
    .string()
    .regex(/^(?!\/)(?!.*\.\.)[\w./-]+\.(ya?ml|json)$/, "Relative path to a .yaml or .json file")
    .optional(),
});

/**
 * Schema of `.qa/qa.project.yaml` (REQ-GEN-01). This is the stage-1 subset; later stages extend it
 * (services and env templates REQ-CFG-02, cleanup REQ-WS-03, publish options REQ-PUB-*).
 */
export const ProjectConfigSchema = z.strictObject({
  project: z.string().regex(/^[a-z][a-z0-9-]*$/, "Use a lowercase project slug"),
  jira: z
    .strictObject({
      /** `cloud` calls Jira Cloud REST v3; `file` reads ticket JSON files (demo, offline, tests). */
      type: z.enum(["cloud", "file"]).default("cloud"),
      base_url: z.url().optional(),
      /** Account e-mail for Jira Cloud basic auth, as a secret reference to keep it out of the repo. */
      email: SecretRef.optional(),
      token: SecretRef.optional(),
      /** Directory with `<KEY>.json` tickets for `type: file`, relative to the `.qa/` folder. */
      tickets_dir: z.string().min(1).optional(),
      project_key: z.string().regex(/^[A-Z][A-Z0-9_]+$/),
      acceptance_criteria_field: z.string().optional(),
    })
    .superRefine((jira, ctx) => {
      const need =
        jira.type === "cloud" ? (["base_url", "email", "token"] as const) : (["tickets_dir"] as const);
      for (const key of need) {
        if (jira[key] === undefined) {
          ctx.addIssue({ code: "custom", path: [key], message: `Required when jira.type is '${jira.type}'` });
        }
      }
    }),
  workspace: z
    .strictObject({
      /** Root of run folders; default `~/.qa-runs`, never the project repository (REQ-WS-01/AC4). */
      root: z.string().min(1).optional(),
      /** Bare mirror cache; default `~/.qa-cache/git` (REQ-CTX-04/AC1). */
      git_cache: z.string().min(1).optional(),
    })
    .default({}),
  code_hosts: z.record(Alias, CodeHostSchema).default({}),
  /** Repository aliases become folder names under `repos/` in the run folder. */
  repos: z.record(Alias, RepoSchema).default({}),
  change_discovery: z
    .array(z.enum(["jira_dev_panel", "ticket_key_in_branch", "ticket_key_in_title"]))
    .default(["jira_dev_panel", "ticket_key_in_branch", "ticket_key_in_title"]),
  environments: z
    .strictObject({
      default: z.string().optional(),
      version_endpoint: z.string().startsWith("/").optional(),
      allowlist: z.array(z.url()).default([]),
      /** Production hosts are unreachable unless this is set (REQ-ENV-01/AC2, invariant 10). */
      allow_production: z.boolean().default(false),
      /** What a non-interactive run does when the deployed SHA differs from the change (REQ-ENV-02/AC2). */
      on_version_mismatch: z.enum(["fail", "warn"]).default("warn"),
      /** Retries after a failed attempt (REQ-EXEC-08/AC1). */
      retries: z.number().int().min(0).max(3).default(1),
    })
    .default({ allowlist: [], allow_production: false, on_version_mismatch: "warn", retries: 1 }),
  models: z
    .strictObject({
      /** Model provider definitions referenced as `<alias>/<model>` in `roles` (REQ-LLM-02/AC2). */
      providers: z.record(Alias, ModelProviderSchema).default({}),
      roles: z.record(z.string(), z.string()).default({}),
      /** Per-run token budget; exceeding it stops the run with BLOCKED (REQ-LLM-07/AC2). */
      token_budget: z.number().int().positive().optional(),
    })
    .default({ providers: {}, roles: {} }),
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
    const providers = result.data.models.providers;
    const missingHosts = [
      ...Object.entries(result.data.repos)
        .filter(([, repo]) => !(repo.host in result.data.code_hosts))
        .map(([alias, repo]) => `repos.${alias}.host: unknown code host '${repo.host}'`),
      ...(Object.keys(providers).length === 0
        ? []
        : Object.entries(result.data.models.roles)
            .filter(([, ref]) => !((ref.split("/")[0] ?? "") in providers))
            .map(([role, ref]) => `models.roles.${role}: unknown provider in '${ref}'`)),
    ];
    if (missingHosts.length === 0) return result.data;
    throw new ConfigError("CONFIG_INVALID", `Invalid configuration in ${source}`, {
      source,
      issues: missingHosts,
    });
  }
  const issues = result.error.issues.map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
  throw new ConfigError("CONFIG_INVALID", `Invalid configuration in ${source}`, { source, issues });
}
