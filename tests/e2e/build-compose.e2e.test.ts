// Stage 6 "done when" (docs/roadmap.md): `qj run DEMO-1 --build` brings the demo-shop up from the fetched
// worktree with Docker Compose, generates its env file from the variable schema and secrets, seeds data
// with the run marker and cleans everything up per policy. Skipped when no Docker daemon is available.
import { execFileSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject, record } from "../support/cli-build.js";

const dockerUp = (() => {
  try {
    execFileSync("docker", ["image", "inspect", "node:22-alpine"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const labelled = (runId: string, kind: "ps" | "volume" | "network"): string[] =>
  execFileSync(
    "docker",
    [
      ...(kind === "ps" ? ["ps", "--all"] : [kind, "ls"]),
      "--filter",
      `label=qajitsu.run=${runId}`,
      "--quiet",
    ],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter(Boolean);

const COMPOSE = [
  "services:",
  "  api:",
  "    kind: compose",
  "    port: 3000",
  "    env:",
  "      DEMO_USER_PASSWORD: { secret: secret://env/DEMO_USER_PASSWORD }",
  '      BUG_CART_TOTAL_ROUNDING: { value: "0", overridable: true }',
  "    health: { http: /health, timeout_s: 120 }",
  "build: { repo: shop, compose_file: docker-compose.yml, base_service: api, profile: local, seed: hooks/seed.mjs }",
].join("\n");

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe.skipIf(!dockerUp)("qj run --build with Docker Compose (stage 6)", () => {
  it("REQ-ENV-03/AC1 + REQ-WS-02 + REQ-ENV-04/AC2 + REQ-WS-03: builds, seeds, passes and leaves nothing behind", async () => {
    const p = await createBuildProject(COMPOSE);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const runId = dir.split("/").at(-1) ?? "";
    const result = await p.run(["run", "DEMO-1", "--build"]);
    expect(result.err).toBe("");
    expect(result.exitCode).toBe(0);
    const { data } = await record(dir);
    expect(data["build"]).toMatchObject({ project: `qj-demo-1-${runId.slice(-4)}` });
    expect(await readFile(join(dir, "logs", "seed.log"), "utf8")).toContain(`seeded qj-DEMO-1-${runId}`);
    expect(await readFile(join(dir, "logs", "api.log"), "utf8")).toContain("demo-shop API on");
    expect(labelled(runId, "ps")).toEqual([]);
    expect(labelled(runId, "network")).toEqual([]);
    expect(await readdir(join(dir, "env"))).toEqual([]);
  }, 300_000);

  it("REQ-NFR-04 + REQ-WS-03/AC1 + AC3: a seeded bug fails; the kept environment is labelled and qj clean removes it", async () => {
    const p = await createBuildProject(COMPOSE);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const runId = dir.split("/").at(-1) ?? "";
    cleanups.push(async () => {
      await p.run(["clean", "DEMO-1", "--run", runId]);
    });
    const result = await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"]);
    expect(result.exitCode).toBe(1);
    expect(labelled(runId, "ps")).toHaveLength(1);
    expect(labelled(runId, "network")).toHaveLength(1);
    expect(await readdir(join(dir, "env"))).not.toContain("api.env");
    const cleaned = await p.run(["clean", "DEMO-1", "--run", runId]);
    expect(cleaned.out).toContain("1 container(s), 0 volume(s), 1 network(s)");
    expect(labelled(runId, "ps")).toEqual([]);
    expect(labelled(runId, "network")).toEqual([]);
  }, 300_000);
});
