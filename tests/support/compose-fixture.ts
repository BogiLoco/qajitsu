import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseProjectConfig, type EnvProvider, type ProjectConfig } from "@qajitsu/core";

const PASSWORD = "fictional-demo-password";

/** The demo-shop API as a managed process of a `--build` environment, for the EnvProvider contract. */
export const composeApiService = {
  kind: "process",
  command: ["node", "api/server.mjs", "--port", "{{port}}"],
  env: { DEMO_USER_PASSWORD: { secret: "secret://env/DEMO_USER_PASSWORD" }, DEMO_SHA: "abc1234" },
  health: { http: "/health", timeout_s: 20 },
};

/** The factory of the compose plugin, as the contract calls it. */
export type CreateComposeEnvProvider = (options: {
  ticket: string;
  runId: string;
  config: ProjectConfig;
  qaDir: string;
  worktree: string;
  envDir: string;
  logsDir: string;
  resolveSecret: (ref: string) => Promise<string>;
}) => EnvProvider;

/** A compose provider over a fresh worktree with the demo-shop API; `cleanup` removes the folder. */
export async function composeProvider(
  create: CreateComposeEnvProvider,
  api: typeof composeApiService,
): Promise<{ provider: EnvProvider; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "qj-build-"));
  const worktree = join(root, "repos", "shop");
  await mkdir(worktree, { recursive: true });
  await cp(fileURLToPath(new URL("../../examples/demo-shop/api", import.meta.url)), join(worktree, "api"), {
    recursive: true,
  });
  await writeFile(
    join(worktree, "docker-compose.yml"),
    "services:\n  db:\n    image: postgres:16\nvolumes:\n  data: {}\n",
  );
  const qaDir = join(root, ".qa");
  await mkdir(join(qaDir, "stubs", "payments"), { recursive: true });
  await mkdir(join(qaDir, "hooks"), { recursive: true });
  const config = parseProjectConfig({
    project: "demo",
    jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    code_hosts: { local: { type: "local", root: "~/git" } },
    repos: { shop: { host: "local", path: "demo-org/demo-shop" } },
    services: { api },
    build: { repo: "shop", base_service: "api" },
  });
  return {
    provider: create({
      ticket: "DEMO-1",
      runId: "20261005-0900-aaaa",
      config,
      qaDir,
      worktree,
      envDir: join(root, "run", "env"),
      logsDir: join(root, "run", "logs"),
      resolveSecret: () => Promise.resolve(PASSWORD),
    }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

/** The same service failing its health check, for the contract's "down" case. */
export const composeFailingService = {
  ...composeApiService,
  command: ["node", "-e", "process.exit(1)"],
  health: { http: "/health", timeout_s: 2 },
};
