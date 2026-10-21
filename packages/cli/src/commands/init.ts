import { execFile } from "node:child_process";
import { access, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { ConfigError, QajitsuError, parseProjectConfig } from "@qajitsu/core";
import { parse, stringify } from "yaml";
import type { CommandIO } from "./fetch.js";

/** What `init` found in the repository (REQ-GEN-03/AC3). */
export interface DetectedProject {
  readonly name: string;
  readonly codeHost:
    | { readonly type: "github" | "gitlab"; readonly baseUrl?: string; readonly path: string }
    | { readonly type: "local"; readonly root: string; readonly path: string };
  readonly composeFile?: string;
  /** Compose services with their first container port. */
  readonly composeServices: readonly { readonly name: string; readonly port?: number }[];
  readonly openapi?: string;
  readonly testTypes: readonly ("api" | "web" | "mobile")[];
}

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );

const gitRemote = (cwd: string): Promise<string | undefined> =>
  new Promise((resolve) => {
    execFile("git", ["-C", cwd, "config", "--get", "remote.origin.url"], { timeout: 10_000 }, (e, out) => {
      resolve(e ? undefined : out.trim() || undefined);
    });
  });

/**
 * Parses a git remote into a code host: github.com and gitlab.* (self-managed included); anything else
 * or no remote becomes a local host over the repository's parent folders.
 *
 * @param remote - `remote.origin.url`, SSH or HTTPS.
 * @param repoDir - The repository folder, for the local fallback.
 */
export function codeHostFromRemote(remote: string | undefined, repoDir: string): DetectedProject["codeHost"] {
  const m = remote
    ? /^(?:https:\/\/(?:[^@/]+@)?|git@|ssh:\/\/git@)([^/:]+)[/:](.+?)(?:\.git)?\/?$/.exec(remote)
    : null;
  const host = m?.[1];
  const path = m?.[2];
  if (host && path && /^[\w.-]+(?:\/[\w.-]+)+$/.test(path)) {
    if (host === "github.com") return { type: "github", path };
    if (host.includes("gitlab"))
      return { type: "gitlab", path, ...(host === "gitlab.com" ? {} : { baseUrl: `https://${host}` }) };
  }
  return {
    type: "local",
    root: dirname(dirname(repoDir)),
    path: `${basename(dirname(repoDir))}/${basename(repoDir)}`,
  };
}

/**
 * Looks at a repository: git remote, compose file and its services, an OpenAPI document and which
 * kinds of tests make sense (web frameworks, Android or iOS projects).
 *
 * @param cwd - Repository folder.
 */
export async function detectProject(cwd: string): Promise<DetectedProject> {
  const entries = new Set(await readdir(cwd).catch(() => [] as string[]));
  const composeFile = ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].find((f) =>
    entries.has(f),
  );
  const composeServices: { name: string; port?: number }[] = [];
  if (composeFile) {
    const doc = parse(await readFile(join(cwd, composeFile), "utf8")) as {
      services?: Record<string, { ports?: unknown[]; expose?: unknown[] }>;
    } | null;
    for (const [name, svc] of Object.entries(doc?.services ?? {})) {
      const raw: unknown = [...(svc.ports ?? []), ...(svc.expose ?? [])][0];
      const spec =
        typeof raw === "object" && raw !== null && "target" in raw
          ? JSON.stringify(raw.target)
          : typeof raw === "string" || typeof raw === "number"
            ? String(raw)
            : "";
      const port = Number(spec.split(":").at(-1)?.split("/")[0]);
      composeServices.push({ name, ...(Number.isInteger(port) && port > 0 ? { port } : {}) });
    }
  }
  const openapiCandidates = [
    "openapi.yaml",
    "openapi.yml",
    "openapi.json",
    "swagger.yaml",
    "swagger.json",
    "api/openapi.yaml",
    "docs/openapi.yaml",
  ];
  let openapi: string | undefined;
  for (const c of openapiCandidates) if (openapi === undefined && (await exists(join(cwd, c)))) openapi = c;
  const pkg = JSON.parse(await readFile(join(cwd, "package.json"), "utf8").catch(() => "{}")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const web =
    deps.some((d) => /^(react|react-dom|vue|svelte|next|nuxt|@angular\/core|solid-js|astro)$/.test(d)) ||
    entries.has("index.html");
  const mobile =
    entries.has("android") ||
    entries.has("ios") ||
    entries.has("build.gradle") ||
    entries.has("build.gradle.kts") ||
    deps.includes("react-native");
  const testTypes: ("api" | "web" | "mobile")[] = [
    "api",
    ...(web ? ["web" as const] : []),
    ...(mobile ? ["mobile" as const] : []),
  ];
  const name =
    basename(cwd)
      .toLowerCase()
      .replace(/[^a-z0-9-]+/g, "-")
      .replace(/^[^a-z]+/, "") || "project";
  return {
    name,
    codeHost: codeHostFromRemote(await gitRemote(cwd), cwd),
    ...(composeFile ? { composeFile } : {}),
    composeServices,
    ...(openapi ? { openapi } : {}),
    testTypes,
  };
}

/** Answers `init` asks for (or takes from flags). */
export interface InitAnswers {
  readonly jiraType: "cloud" | "datacenter" | "file";
  readonly jiraUrl?: string | undefined;
  readonly projectKey: string;
  readonly envUrl: string;
  /** Models of a cloud provider whose key was found and accepted (REQ-LLM-09/AC1). */
  readonly models?: ProposedModels | undefined;
  /** `budget.max_cost_usd` (REQ-LLM-09/AC4). */
  readonly maxCostUsd?: number | undefined;
}

/** A provider key found by its variable name (REQ-LLM-09/AC1); the value is never read into the result. */
export interface FoundKey {
  readonly provider: "anthropic" | "openai" | "google" | "openrouter";
  readonly variable: string;
  readonly where: "environment" | ".env.local";
}

/** The `models` section proposed for a found key. */
export interface ProposedModels {
  readonly providers: Readonly<Record<string, unknown>>;
  readonly roles: Readonly<Record<string, string>>;
  readonly summary: string;
}

const KEY_VARIABLES: readonly [FoundKey["provider"], string][] = [
  ["anthropic", "ANTHROPIC_API_KEY"],
  ["openai", "OPENAI_API_KEY"],
  ["google", "GOOGLE_GENERATIVE_AI_API_KEY"],
  ["google", "GEMINI_API_KEY"],
  ["openrouter", "OPENROUTER_API_KEY"],
];

/** Default spending limit per run proposed with a paid provider (REQ-LLM-09/AC4). */
export const DEFAULT_MAX_COST_USD = 5;

/**
 * Provider keys present in the environment or in the project's `.env.local`, by variable name only (REQ-LLM-09/AC1).
 * Values are neither returned nor printed.
 *
 * @param env - The process environment.
 * @param envFile - Text of `.env.local`, if any.
 */
export function findApiKeys(
  env: Readonly<Record<string, string | undefined>>,
  envFile: string | undefined,
): FoundKey[] {
  const inFile = new Set(
    (envFile ?? "")
      .split("\n")
      .flatMap((line) => /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1] ?? []),
  );
  return KEY_VARIABLES.flatMap(([provider, variable]): FoundKey[] =>
    env[variable] !== undefined && env[variable] !== ""
      ? [{ provider, variable, where: "environment" }]
      : inFile.has(variable)
        ? [{ provider, variable, where: ".env.local" }]
        : [],
  );
}

/**
 * The models proposed for a found key, for providers whose models have built-in profiles and prices
 * (REQ-LLM-09/AC1+AC2); undefined for the others, which are set up by hand.
 */
export function proposeModels(key: FoundKey): ProposedModels | undefined {
  if (key.provider !== "anthropic") return undefined;
  return {
    providers: { anthropic: { type: "anthropic", api_key: `secret://env/${key.variable}`, models: {} } },
    // The auditor is another model than the author by default (REQ-VER-06); Haiku reads screenshots too.
    roles: { default: "anthropic/claude-sonnet-5-5", auditor: "anthropic/claude-haiku-5-5" },
    summary: "anthropic/claude-sonnet-5-5 for every role, anthropic/claude-haiku-5-5 as the auditor",
  };
}

/**
 * Builds `.qa/qa.project.yaml` and `.qa/envs/<env>.yaml` from what was detected and answered; the result
 * is validated with the same schema `qajitsu` loads, so `init` never writes a config that does not load.
 *
 * @throws {ConfigError} `CONFIG_INVALID` when the answers do not form a valid configuration.
 */
export function renderInitConfig(d: DetectedProject, a: InitAnswers): { project: string; env: string } {
  const alias = d.codeHost.type === "local" ? "local" : d.codeHost.type;
  const repo =
    basename(d.codeHost.path)
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z]+/, "") || "app";
  const appService = d.composeServices.find((s) => s.port !== undefined);
  const project = {
    project: d.name,
    jira:
      a.jiraType === "file"
        ? { type: "file", tickets_dir: "tickets", project_key: a.projectKey }
        : {
            type: a.jiraType,
            base_url: a.jiraUrl,
            ...(a.jiraType === "cloud" ? { email: "secret://env/JIRA_EMAIL" } : {}),
            token: "secret://env/JIRA_TOKEN",
            project_key: a.projectKey,
          },
    code_hosts: {
      [alias]:
        d.codeHost.type === "local"
          ? { type: "local", root: d.codeHost.root }
          : {
              type: d.codeHost.type,
              ...(d.codeHost.baseUrl ? { base_url: d.codeHost.baseUrl } : {}),
              token: `secret://env/${d.codeHost.type.toUpperCase()}_TOKEN`,
            },
    },
    repos: { [repo]: { host: alias, path: d.codeHost.path, ...(d.openapi ? { openapi: d.openapi } : {}) } },
    environments: { default: "local", allowlist: [new URL(a.envUrl).origin] },
    models: a.models
      ? { providers: a.models.providers, roles: a.models.roles }
      : {
          providers: { local: { type: "ollama", base_url: "http://localhost:11434", models: {} } },
          roles: { default: "local/qwen2.5-coder:32b" },
        },
    ...(a.maxCostUsd === undefined ? {} : { budget: { max_cost_usd: a.maxCostUsd } }),
    ...(d.composeFile && appService
      ? {
          services: Object.fromEntries(
            d.composeServices
              .filter((s) => s.port !== undefined)
              .map((s) => [
                s.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
                {
                  kind: "compose",
                  compose_service: s.name,
                  port: s.port,
                  health: { port: true, timeout_s: 120 },
                },
              ]),
          ),
          build: {
            repo,
            compose_file: d.composeFile,
            base_service: appService.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-"),
            profile: "local",
          },
        }
      : {}),
    test_types: d.testTypes,
  };
  parseProjectConfig(project, ".qa/qa.project.yaml (generated)");
  const env = { base_url: a.envUrl, health_path: "/health", accounts: {} };
  const header =
    "# Generated by `qajitsu init` (REQ-GEN-03). Secrets stay out of this file: use secret:// references.\n";
  return {
    project: header + stringify(project),
    env: `# Environment profile (REQ-ENV-01). Add accounts as aliases with secret:// passwords.\n${stringify(env)}`,
  };
}

/**
 * `qajitsu init [--yes] [--force] [--jira-url] [--project-key] [--env-url]`: creates `.qa/` for the current
 * repository (REQ-GEN-03/AC3). Interactive when a terminal is attached; `--yes` takes defaults and flags.
 */
export async function runInit(
  options: {
    readonly yes?: boolean | undefined;
    readonly force?: boolean | undefined;
    readonly jiraUrl?: string | undefined;
    readonly projectKey?: string | undefined;
    readonly envUrl?: string | undefined;
    /** The process environment, to find provider keys by name (REQ-LLM-09/AC1). */
    readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  },
  io: CommandIO,
): Promise<number> {
  try {
    const qaDir = join(io.cwd, ".qa");
    if ((await exists(join(qaDir, "qa.project.yaml"))) && options.force !== true)
      throw new ConfigError(
        "INIT_EXISTS",
        ".qa/qa.project.yaml already exists; pass --force to replace it.",
        {},
      );
    const d = await detectProject(io.cwd);
    io.write(
      `Detected: ${d.codeHost.type} repository ${d.codeHost.path}; tests: ${d.testTypes.join(", ")}${d.composeFile ? `; ${d.composeFile} with ${String(d.composeServices.length)} service(s)` : ""}${d.openapi ? `; OpenAPI ${d.openapi}` : ""}\n`,
    );
    const ask = async (question: string, fallback: string | undefined): Promise<string> => {
      if (options.yes === true || !io.ask) return fallback ?? "";
      const answer = (await io.ask(`${question}${fallback ? ` [${fallback}]` : ""}: `)).trim();
      return answer === "" ? (fallback ?? "") : answer;
    };
    const jiraUrl = await ask("Jira URL (empty: tickets from files)", options.jiraUrl);
    const projectKey = (await ask("Jira project key", options.projectKey ?? "PROJ")).toUpperCase();
    const envUrl = await ask("URL of the test environment", options.envUrl ?? "http://localhost:3000");
    // REQ-LLM-09/AC1: a provider key by its name; its models are written only after a yes.
    const keys = findApiKeys(
      options.env ?? {},
      await readFile(join(io.cwd, ".env.local"), "utf8").catch(() => undefined),
    );
    let models: ProposedModels | undefined;
    let maxCostUsd: number | undefined;
    for (const key of keys) {
      const proposed = proposeModels(key);
      if (!proposed) {
        io.write(
          `Found ${key.variable} (${key.where}): ${key.provider} is not set up automatically yet; add it under models.providers with api_key: secret://env/${key.variable}, choose models in models.roles and declare cost_per_mtok for a cost in dollars.\n`,
        );
        continue;
      }
      if (models) continue;
      io.write(`Found ${key.variable} (${key.where}): Anthropic can run every role.\n`);
      const use = (await ask(`Use it for ${proposed.summary}? (y/n)`, "y")).toLowerCase();
      if (!use.startsWith("y")) continue;
      const limit = Number(await ask("Spending limit per run in US dollars", String(DEFAULT_MAX_COST_USD)));
      models = proposed;
      maxCostUsd = Number.isFinite(limit) && limit > 0 ? limit : DEFAULT_MAX_COST_USD;
      io.write(`Models: ${proposed.summary}; at most $${maxCostUsd.toFixed(2)} per run\n`);
    }
    const answers: InitAnswers = {
      jiraType: jiraUrl === "" ? "file" : jiraUrl.includes("atlassian.net") ? "cloud" : "datacenter",
      ...(jiraUrl === "" ? {} : { jiraUrl }),
      projectKey,
      envUrl,
      ...(models ? { models, maxCostUsd } : {}),
    };
    const files = renderInitConfig(d, answers);
    await mkdir(join(qaDir, "envs"), { recursive: true });
    await mkdir(join(qaDir, "knowledge"), { recursive: true });
    await writeFile(join(qaDir, "qa.project.yaml"), files.project, "utf8");
    await writeFile(join(qaDir, "envs", "local.yaml"), files.env, "utf8");
    if (answers.jiraType === "file") await mkdir(join(qaDir, "tickets"), { recursive: true });
    io.write(
      [
        "Created .qa/qa.project.yaml and .qa/envs/local.yaml.",
        "Next: put secrets in .env.local (JIRA_TOKEN, GITHUB_TOKEN, ...), choose models in models.roles,",
        "then run 'qajitsu doctor --online' and 'qajitsu fetch <TICKET>'.",
        "",
      ].join("\n"),
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
