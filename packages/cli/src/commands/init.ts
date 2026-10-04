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
    models: {
      providers: { local: { type: "ollama", base_url: "http://localhost:11434", models: {} } },
      roles: { default: "local/qwen2.5-coder:32b" },
    },
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
    const answers: InitAnswers = {
      jiraType: jiraUrl === "" ? "file" : jiraUrl.includes("atlassian.net") ? "cloud" : "datacenter",
      ...(jiraUrl === "" ? {} : { jiraUrl }),
      projectKey,
      envUrl,
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
