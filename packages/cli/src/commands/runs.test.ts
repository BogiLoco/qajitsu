import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { CommandExec } from "@qajitsu/adapter-env-compose";
import { RunRecordSchema, readRunIndex, type TicketKey } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { PASSWORD, apiService, createBuildProject } from "../../../../tests/support/cli-build.js";
import { nextStage } from "./runs.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const setup = async (services?: string, options: Parameters<typeof createBuildProject>[1] = {}) => {
  const p = await createBuildProject(services, options);
  cleanups.push(p.cleanup);
  return p;
};
const index = (home: string) => readRunIndex(join(home, "runs"), "DEMO-1" as TicketKey);

describe("run management (REQ-WS-04, REQ-WS-03)", () => {
  it("REQ-WS-04/AC3: nextStage follows the checkpoints and stops at human gates", () => {
    const at = "2026-10-03T10:00:00Z";
    const rec = (stages: string[]) =>
      RunRecordSchema.parse({
        schema: 1,
        ticket: "DEMO-1",
        runId: "20261003-1046-aaaa",
        createdAt: at,
        updatedAt: at,
        status: "running",
        checkpoints: stages.map((stage) => ({ stage, at })),
      });
    expect(nextStage(rec([]), 0).next).toBe("fetch-again");
    expect(nextStage(rec(["fetch"]), 0).next).toBe("plan");
    expect(nextStage(rec(["fetch"]), 1).next).toBe("approve");
    expect(nextStage(rec(["fetch", "approve"]), 1).next).toBe("run");
    expect(nextStage(rec(["fetch", "approve", "run"]), 1).next).toBe("publish");
    expect(nextStage(rec(["fetch", "approve", "run", "publish"]), 1).next).toBe("done");
  });

  it("REQ-WS-04/AC1 + AC3: resume plans, stops for approval, runs with --build, then points to publish; runs lists it", async () => {
    const { run, home } = await setup();
    expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const analysis = JSON.stringify({
      summary: "Cart API.",
      change_type: ["api"],
      endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    const draft = await readFile(
      new URL("../../../../fixtures/plans/demo-1-draft.json", import.meta.url),
      "utf8",
    );
    const planned = await run(["resume", "DEMO-1"], [{ text: analysis }, { text: draft }]);
    expect(planned.out).toContain("next: plan");
    expect(planned.exitCode).toBe(0);
    const waiting = await run(["resume", "DEMO-1"]);
    expect(waiting.exitCode).toBe(2);
    expect(waiting.out).toContain("approve it with 'qajitsu approve'");
    expect((await run(["approve", "DEMO-1"])).exitCode).toBe(0);
    const runId = (await index(home)).latest ?? "";
    const dir = join(home, "runs", "DEMO-1", runId);
    for (const id of ["TC-01", "TC-02"])
      await writeFile(
        join(dir, "specs", `${id}.spec.ts`),
        await readFile(new URL(`../../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url)),
      );
    const ran = await run(["resume", "DEMO-1", "--build"]);
    expect(ran.out).toContain("next: run");
    expect(ran.exitCode).toBe(0);
    const after = await run(["resume", "DEMO-1"]);
    expect(after.out).toContain("next: publish");
    const listed = await run(["runs", "DEMO-1"]);
    expect(listed.out).toContain(`| ${runId} (latest) |`);
    expect(listed.out).toContain("2 PASSED");
    expect((await run(["runs", "DEMO-2"])).out).toContain("No runs for DEMO-2");
    expect((await run(["runs", "bad"])).exitCode).toBe(3);
    expect((await run(["resume", "DEMO-2"])).err).toContain("RUN_NOT_FOUND");
  }, 120_000);

  it("REQ-WS-03/AC3 + AC4: clean removes labelled resources, worktrees and env files; artifacts stay; a held run is skipped", async () => {
    const calls: string[][] = [];
    const exec: CommandExec = (cmd, args) => {
      calls.push([cmd, ...args]);
      return Promise.resolve({ stdout: args[0] === "ps" ? "c1\n" : "", stderr: "" });
    };
    const { run, home } = await setup(undefined, { buildExec: exec });
    expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const runId = (await index(home)).latest ?? "";
    const dir = join(home, "runs", "DEMO-1", runId);
    await writeFile(join(dir, "env", "api.env"), `DEMO_USER_PASSWORD="${PASSWORD}"\n`);
    expect(await readdir(join(dir, "repos"))).toContain("shop");
    const cleaned = await run(["clean", "DEMO-1"]);
    expect(cleaned.out).toContain(
      `${runId}: 1 container(s), 0 volume(s), 0 network(s), 2 worktree/env path(s) removed`,
    );
    expect(calls).toContainEqual(["docker", "rm", "--force", "--volumes", "c1"]);
    expect(
      calls.filter((c) => c.includes("--quiet")).every((c) => c.includes(`label=qajitsu.run=${runId}`)),
    ).toBe(true);
    expect(await readdir(join(dir, "repos"))).not.toContain("shop");
    expect(await readdir(join(dir, "env"))).toEqual([]);
    expect(await readdir(join(dir, "ticket"))).not.toEqual([]);
    // REQ-WS-04/AC2: a run held by a live process is not touched.
    await writeFile(join(dir, "run.lock"), `${String(process.ppid)}\n`);
    expect((await run(["clean", "DEMO-1", "--all"])).out).toContain("in use by another process, skipped");
    expect((await run(["clean", "DEMO-9"])).err).toContain("RUN_NOT_FOUND");
  }, 120_000);

  it("REQ-WS-03/AC2 + REQ-WS-04/AC1: gc keeps the newest keep_last runs and removes the rest with their folders", async () => {
    let day = 0;
    const { run, home } = await setup(`${apiService()}\ncleanup: { keep_last: 1, max_age_days: 365 }`, {
      now: () => new Date(Date.UTC(2026, 9, 1 + day)),
    });
    for (let i = 0; i < 3; i += 1) {
      day = i;
      expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    }
    const before = await index(home);
    expect(before.runs).toHaveLength(3);
    const dry = await run(["gc", "--dry-run"]);
    expect(dry.out).toContain("2 run(s) selected");
    expect((await index(home)).runs).toHaveLength(3);
    const done = await run(["gc"]);
    expect(done.out).toContain("2 run(s) processed");
    const after = await index(home);
    expect(after.runs.map((r) => r.runId)).toEqual([before.latest]);
    expect(after.latest).toBe(before.latest);
    const removed = before.runs.find((r) => r.runId !== before.latest)?.runId ?? "";
    await expect(stat(join(home, "runs", "DEMO-1", removed))).rejects.toThrow();
  }, 120_000);
});

describe("qajitsu env (REQ-CFG-04, REQ-CFG-05)", () => {
  it("REQ-CFG-04/AC1: env check lists missing variables without starting anything; a complete config passes", async () => {
    const broken = await setup(
      apiService().replace("secret://env/DEMO_USER_PASSWORD", "secret://env/MISSING_PASSWORD"),
    );
    const check = await broken.run(["env", "check"]);
    expect(check.exitCode).toBe(3);
    expect(check.out).toContain(
      "✘ api.DEMO_USER_PASSWORD: secret secret://env/MISSING_PASSWORD cannot be resolved",
    );
    const ok = await setup();
    const good = await ok.run(["env", "check"]);
    expect(good.out).toContain("✔ configuration complete");
    expect(good.exitCode).toBe(0);
    expect((await ok.run(["env", "check", "--env", "missing"])).out).toContain("✘ environment missing");
  });

  it("REQ-CFG-05/AC3: env render recreates the per-service .env files with 0600", async () => {
    const { run, home } = await setup();
    expect((await run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const rendered = await run(["env", "render", "DEMO-1"]);
    expect(rendered.exitCode).toBe(0);
    expect(rendered.out).not.toContain(PASSWORD);
    const runId = (await index(home)).latest ?? "";
    const file = join(home, "runs", "DEMO-1", runId, "env", "api.env");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toContain(`DEMO_USER_PASSWORD='${PASSWORD}'`);
    expect((await run(["env", "render", "DEMO-9"])).exitCode).toBe(3);
  });
});
