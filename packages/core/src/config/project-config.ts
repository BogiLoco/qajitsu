import { z } from "zod";
import { ConfigError } from "../errors.js";
import { MobileSchema } from "./mobile.js";
import { BuildSchema, CleanupSchema, ServiceSchema } from "./services.js";

/** A script in `.qa/hooks/`, relative to `.qa/`. */
const HookPath = z
  .string()
  .regex(/^hooks\/[\w.-]+(\/[\w.-]+)*$/, "Hooks live in .qa/hooks/")
  .refine((p) => !p.split("/").includes(".."), "Hooks live in .qa/hooks/");

const SecretRef = z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Expected a secret:// reference");
/** A bootstrap secret of a secret manager: only the `env` provider can hold it (REQ-CFG-03/AC3). */
const EnvSecretRef = z
  .string()
  .regex(/^secret:\/\/env\/[A-Za-z_][A-Za-z0-9_]*$/, "Secret manager tokens come from secret://env/<NAME>");

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

/** Credentials are only sent over HTTPS; `http://localhost` stays allowed for local tools (stage-4 review). */
const SecureUrl = z
  .url()
  .refine(
    (u) => u.startsWith("https://") || /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/.test(u),
    "Use https:// (credentials are sent to this URL)",
  );

const IdSchema = z.union([z.string().regex(/^\d+$/), z.number().int().positive()]).transform(String);

const CodeHostSchema = z
  .strictObject({
    /** `local` serves git repositories from a directory (demo-shop, offline runs, e2e tests). */
    type: z.enum(["github", "gitlab", "local"]),
    /** Directory with `<path>` repositories for `type: local`; `~/` and paths relative to `.qa/` allowed. */
    root: z.string().min(1).optional(),
    /** Web URL of a self-hosted instance (GitHub Enterprise Server, GitLab self-managed). */
    base_url: SecureUrl.optional(),
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
  /**
   * Tests repository only: folder that `qj promote` writes regression packs to (REQ-PUB-08); default: `qajitsu/`
   * inside the repository's `tests/`, `test/` or `e2e/` folder.
   */
  promote_dir: z
    .string()
    .regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/, "Relative folder inside the tests repository")
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
      /** `cloud`: Jira Cloud REST v3; `datacenter`: Jira Data Center REST v2; `file`: ticket JSON files (demo, offline, tests). */
      type: z.enum(["cloud", "datacenter", "file"]).default("cloud"),
      base_url: SecureUrl.optional(),
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
        jira.type === "cloud"
          ? (["base_url", "email", "token"] as const)
          : jira.type === "datacenter"
            ? (["base_url", "token"] as const)
            : (["tickets_dir"] as const);
      for (const key of need) {
        if (jira[key] === undefined) {
          ctx.addIssue({ code: "custom", path: [key], message: `Required when jira.type is '${jira.type}'` });
        }
      }
    }),
  /** Services started by `--build` (REQ-ENV-03, REQ-CFG-02, REQ-ENV-05). */
  services: z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/), ServiceSchema).default({}),
  build: BuildSchema.optional(),
  /** OpenTelemetry export of every run (REQ-OBS-03): traces, logs and metrics over OTLP/HTTP JSON. */
  telemetry: z
    .strictObject({
      otlp: z.strictObject({
        /** Collector base URL, e.g. `http://localhost:4318`; `/v1/traces`, `/v1/logs`, `/v1/metrics` are appended. */
        endpoint: z.url().refine((u) => {
          const url = new URL(u);
          return url.protocol === "https:" || ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        }, "Use https for a collector that is not on this machine"),
        /** Extra headers; values may be `secret://` references (API keys of Grafana Cloud, Datadog, Langfuse). */
        headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string()).default({}),
        service_name: z.string().min(1).default("qajitsu"),
        /**
         * Send full event details (tool arguments and results, error messages, ticket and plan data).
         * Default false: only identifiers, codes, counts and statuses leave the machine.
         */
        include_details: z.boolean().default(false),
      }),
    })
    .optional(),
  /** Audit log retention, separate from workspace cleanup (REQ-OBS-05/AC2). */
  audit: z
    .strictObject({
      /** Days a deleted run's journal is kept in `<workspace root>/.audit/`. */
      retention_days: z.number().int().min(1).max(3650).default(365),
    })
    .default({ retention_days: 365 }),
  /** Cleanup policy and retention (REQ-WS-03). */
  cleanup: CleanupSchema.default({ policy: "on_success", keep_last: 10, max_age_days: 30 }),
  /** Extra checks after the runner's verdict; they can only downgrade (REQ-VER-06, REQ-VER-09). */
  verification: z
    .strictObject({
      /**
       * Independent auditor of PASSED results (REQ-VER-06). `optional`: an auditor failure is reported
       * and statuses stay; `required`: an auditor failure turns every PASSED into NEEDS_REVIEW; `off`.
       */
      auditor: z.enum(["optional", "required", "off"]).default("optional"),
      /** Screenshots the auditor sees per run (vision models only). */
      auditor_max_images: z.number().int().min(0).max(50).default(12),
      /** Run one step with an inverted expectation; if it passes, the run becomes NEEDS_REVIEW (REQ-VER-09). */
      canary: z.boolean().default(false),
      /** Suggested causes of FAILED cases with cited evidence (REQ-VER-12); never a status. */
      triage: z.enum(["on", "off"]).default("on"),
    })
    .default({ auditor: "optional", auditor_max_images: 12, canary: false, triage: "on" }),
  /** Mobile runner, devices and app binaries (REQ-EXEC-06, REQ-ENV-06, REQ-EVD-03). */
  mobile: MobileSchema.optional(),
  /** Web runner (REQ-EXEC-05, REQ-EVD-06). */
  web: z
    .strictObject({
      browser: z.enum(["chromium", "firefox", "webkit"]).default("chromium"),
      video: z.enum(["retain-on-failure", "always", "off"]).default("retain-on-failure"),
      headless: z.boolean().default(true),
      action_timeout_ms: z.number().int().min(500).max(120_000).default(5_000),
      /**
       * Browser and viewport matrix (REQ-EXEC-13): web cases run in every combination; the first combination is the
       * primary run. Without it web cases run once in `browser` at 1280×800.
       */
      matrix: z
        .strictObject({
          browsers: z.array(z.enum(["chromium", "firefox", "webkit"])).min(1),
          viewports: z
            .array(
              z.strictObject({
                name: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/),
                width: z.number().int().min(200).max(7680),
                height: z.number().int().min(200).max(4320),
              }),
            )
            .min(1)
            .default([{ name: "desktop", width: 1280, height: 800 }]),
        })
        .optional(),
    })
    .default({ browser: "chromium", video: "retain-on-failure", headless: true, action_timeout_ms: 5_000 }),
  /** Publishing results to the ticket (REQ-PUB-01..04, REQ-VER-10). */
  publish: z
    .strictObject({
      /** Largest attachment uploaded, in MB; bigger files are listed but not uploaded (REQ-PUB-02/AC3). */
      max_attachment_mb: z.number().positive().max(2048).default(10),
      /** Skip the confirmation preview (CI); recorded in run.json (REQ-VER-10/AC2). */
      auto: z.boolean().default(false),
      /** Hosts Jira may redirect attachment downloads to; fetched without credentials (qj pull). */
      media_hosts: z.array(z.string().regex(/^[a-z0-9.-]+$/)).default(["media.atlassian.com"]),
    })
    .default({ max_attachment_mb: 10, auto: false, media_hosts: ["media.atlassian.com"] }),
  workspace: z
    .strictObject({
      /** Root of run folders; default `<project-home>/runs/`, never the project repository (REQ-WS-01/AC4). */
      root: z.string().min(1).optional(),
      /** Bare mirror cache; default `<project-home>/cache/git/` (REQ-CTX-04/AC1). */
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
      /** Cases running in parallel (REQ-EXEC-10/AC1). */
      workers: z.number().int().min(1).max(16).default(1),
    })
    .default({ allowlist: [], allow_production: false, on_version_mismatch: "warn", retries: 1, workers: 1 }),
  models: z
    .strictObject({
      /** Model provider definitions referenced as `<alias>/<model>` in `roles` (REQ-LLM-02/AC2). */
      providers: z.record(Alias, ModelProviderSchema).default({}),
      roles: z.record(z.string(), z.string()).default({}),
      /** Per-run token budget; exceeding it stops the run with BLOCKED (REQ-LLM-07/AC2). */
      token_budget: z.number().int().positive().optional(),
    })
    .default({ providers: {}, roles: {} }),
  /**
   * Scripts from `.qa/hooks/` around every run (REQ-GEN-01/AC2): `setup` after the environment is healthy and
   * before the cases (a failure makes every case BLOCKED), `teardown` after the cases (a failure is a warning).
   */
  hooks: z
    .strictObject({
      setup: HookPath.optional(),
      teardown: HookPath.optional(),
      timeout_s: z.number().int().min(1).max(1800).default(120),
    })
    .default({ timeout_s: 120 }),
  /**
   * Passive observations while planned cases run (REQ-EVD-07): computed by code, listed in the report and the Jira
   * comment, never a status. `ignore` drops observations whose text contains one of the strings (a rule id, a URL
   * part, a console message).
   */
  observations: z
    .strictObject({
      console: z.boolean().default(true),
      http_errors: z.boolean().default(true),
      accessibility: z.boolean().default(true),
      ignore: z.array(z.string().min(1)).default([]),
    })
    .default({ console: true, http_errors: true, accessibility: true, ignore: [] }),
  /**
   * Secret managers besides `env` (REQ-CFG-03/AC3). Their own tokens are bootstrap secrets and always come from the
   * `env` provider. References: `secret://vault/<path>#<field>`, `secret://doppler/<NAME>`,
   * `secret://op/<vault>/<item>/<field>`, `secret://aws/<secret-id>[#<json-key>]`, `secret://gcp/<name>[@<version>]`.
   */
  secrets: z
    .strictObject({
      vault: z
        .strictObject({
          address: z.url(),
          mount: z
            .string()
            .regex(/^[\w-]+$/)
            .default("secret"),
          namespace: z
            .string()
            .regex(/^[\w/-]+$/)
            .optional(),
          token: EnvSecretRef,
        })
        .optional(),
      doppler: z
        .strictObject({
          project: z.string().regex(/^[\w-]+$/),
          config: z.string().regex(/^[\w-]+$/),
          token: EnvSecretRef,
        })
        .optional(),
      /** 1Password through the `op` CLI (service account or desktop app sign-in). */
      op: z.strictObject({}).optional(),
      aws: z
        .strictObject({
          region: z.string().regex(/^[a-z]{2}(-[a-z]+)+-\d$/),
          profile: z
            .string()
            .regex(/^[\w.-]+$/)
            .optional(),
        })
        .optional(),
      gcp: z.strictObject({ project: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/) }).optional(),
    })
    .default({}),
  /**
   * MCP servers agents may use to explore the application (REQ-EXEC-01): started per stage without a shell, with a
   * minimal environment, outside the run workspace. Only the listed tools are offered, every call goes through the
   * guard (REQ-VER-03/AC3) and exploration never counts as test execution.
   */
  mcp: z
    .strictObject({
      servers: z
        .record(
          z.string().regex(/^[a-z][a-z0-9_-]{0,30}$/),
          z.strictObject({
            /** Command and arguments; `{{allowed_origins}}` becomes the environment allowlist joined by `;`. */
            command: z.array(z.string().min(1)).min(1),
            roles: z
              .array(z.enum(["author"]))
              .min(1)
              .default(["author"]),
            tools: z.array(z.string().regex(/^[\w.-]+$/)).min(1),
            timeout_s: z.number().int().min(1).max(300).default(30),
          }),
        )
        .default({}),
    })
    .default({ servers: {} }),
  /**
   * Message capture for e-mails, SMS gateways and outgoing webhooks (REQ-ENV-08): webhook.site, hosted or
   * self-hosted. Each case gets its own inbox, deleted when the run ends; the host must be on the allowlist.
   */
  messages: z
    .strictObject({
      provider: z.literal("webhook.site").default("webhook.site"),
      base_url: SecureUrl.default("https://webhook.site"),
      email_domain: z
        .string()
        .regex(/^[a-z0-9.-]+\.[a-z]{2,}$/)
        .default("email.webhook.site"),
      api_key: SecretRef.optional(),
      /** Default wait for a planned message when the plan gives no `within_s`. */
      timeout_s: z.number().int().min(1).max(3600).default(120),
      poll_ms: z.number().int().min(200).max(60_000).default(2000),
    })
    .optional(),
  /**
   * Run budget (REQ-PLAN-08/AC3): when the time since the run started or the model cost of the run reaches a limit,
   * the remaining cases are NOT_RUN with the reason (cost is checked before writing each spec, time before each case).
   */
  budget: z
    .strictObject({
      max_minutes: z.number().positive().max(1440).optional(),
      max_cost_usd: z.number().positive().optional(),
    })
    .default({}),
  /**
   * Visual regression (REQ-EXEC-12): baselines live in `.qa/baselines/`; `threshold` is the default share of differing
   * pixels that still passes, `color_threshold` the per-pixel sensitivity (0 exact, 1 anything).
   */
  visual: z
    .strictObject({
      threshold: z.number().min(0).max(1).default(0.001),
      color_threshold: z.number().min(0).max(1).default(0.1),
    })
    .default({ threshold: 0.001, color_threshold: 0.1 }),
  /**
   * Locales cases can run in (REQ-EXEC-14/AC1): the browser gets the locale and time zone, API calls an
   * `Accept-Language` header. A case lists the ones it runs in (`locales` in the plan).
   */
  locales: z
    .array(
      z.strictObject({
        name: z.string().regex(/^[a-z]{2,3}(-[A-Z][A-Za-z]{1,3})?$/, "Locale like pl-PL"),
        timezone: z.string().regex(/^[A-Za-z]+(?:\/[A-Za-z0-9_+-]+)*$/, "IANA time zone like Europe/Warsaw"),
      }),
    )
    .default([]),
  /** Manual steps (REQ-EXEC-11): how long the run waits for a person's answer per step. */
  manual: z
    .strictObject({ timeout_s: z.number().int().min(1).max(86_400).default(900) })
    .default({ timeout_s: 900 }),
  /**
   * The project's knowledge base (REQ-KNOW-01, REQ-KNOW-07, REQ-KNOW-08, ADR-0007): documents added with
   * `qj knowledge add`, searchable by the analyst and planner. Documentation that fits `full_context_tokens` is used
   * without embeddings; above it retrieval is hybrid (vectors plus keywords) with `embedding`.
   */
  knowledge: z
    .strictObject({
      /** `<provider>/<model>` of the embedding model through `models.providers`; a local Ollama model by default. */
      embedding: z
        .string()
        .regex(/^[\w.-]+\/.+$/)
        .default("ollama/nomic-embed-text"),
      store: z.enum(["lancedb", "chroma"]).default("lancedb"),
      /**
       * Confluence for `qj knowledge add confluence:<SPACE>` (REQ-KNOW-12/AC1). On Jira Cloud it defaults to
       * `<jira.base_url>/wiki` with the Jira e-mail and token; Data Center needs its own `base_url` and token.
       */
      confluence: z
        .strictObject({
          base_url: SecureUrl.optional(),
          type: z.enum(["cloud", "datacenter"]).optional(),
          email: SecretRef.optional(),
          token: SecretRef.optional(),
        })
        .optional(),
      /** A shared Chroma server (REQ-KNOW-08/AC3); URL and token are secret:// references. */
      chroma: z.strictObject({ url: SecretRef, token: SecretRef.optional() }).optional(),
      /** Documentation up to this size (about 4 characters per token) is used in full, without embeddings. */
      full_context_tokens: z.number().int().min(0).max(1_000_000).default(20_000),
      /** Chunks from which approximate vector and full-text indexes are built (REQ-KNOW-01/AC4). */
      index_threshold: z.number().int().min(256).default(50_000),
      /** Chunks of files older than this are marked as possibly outdated in plans (REQ-KNOW-10/AC1). */
      max_age_days: z.number().int().positive().optional(),
      /** Sync registered sources before every `qj plan` (REQ-KNOW-04/AC3). */
      auto_sync: z.boolean().default(false),
    })
    .default({
      embedding: "ollama/nomic-embed-text",
      store: "lancedb",
      full_context_tokens: 20_000,
      index_threshold: 50_000,
      auto_sync: false,
    }),
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
    const build = result.data.build;
    const buildIssues: string[] = [];
    if (build) {
      if (!(build.repo in result.data.repos))
        buildIssues.push(`build.repo: unknown repository '${build.repo}'`);
      if (!(build.base_service in result.data.services))
        buildIssues.push(`build.base_service: unknown service '${build.base_service}'`);
      if (
        Object.values(result.data.services).some((s) => s.kind === "compose") &&
        build.compose_file === undefined
      ) {
        buildIssues.push("build.compose_file: required when a service has kind: compose");
      }
    }
    const providers = result.data.models.providers;
    const missingHosts = [
      ...buildIssues,
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

/** One browser and viewport combination of the web matrix (REQ-EXEC-13). */
export interface WebCombination {
  /** `<browser>-<viewport>`, e.g. `firefox-mobile`; names result and evidence folders. */
  readonly id: string;
  readonly browser: "chromium" | "firefox" | "webkit";
  readonly viewport: { readonly name: string; readonly width: number; readonly height: number };
}

/**
 * The web combinations of a project, primary first (REQ-EXEC-13/AC1): every browser × viewport of `web.matrix`, or
 * the single `web.browser` at 1280×800.
 */
export function webCombinations(web: ProjectConfig["web"]): WebCombination[] {
  const viewports = web.matrix?.viewports ?? [{ name: "desktop", width: 1280, height: 800 }];
  return (web.matrix?.browsers ?? [web.browser]).flatMap((browser) =>
    viewports.map((viewport) => ({ id: `${browser}-${viewport.name}`, browser, viewport })),
  );
}
