import { readFile, readdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
/** A build project whose runs and git mirrors use the defaults: the project home. */
const setup = async () => {
  const p = await createBuildProject();
  cleanups.push(p.cleanup);
  const yaml = join(p.project, ".qa", "qa.project.yaml");
  await writeFile(
    yaml,
    (await readFile(yaml, "utf8")).replace("workspace: { root: ~/runs, git_cache: ~/cache }\n", ""),
  );
  const projectHome = join(p.home, ".qajitsu", "projects", "demo");
  return { ...p, projectHome, runs: join(projectHome, "runs") };
};
const fetchRun = async (p: Awaited<ReturnType<typeof setup>>) => {
  expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
  const index = JSON.parse(await readFile(join(p.runs, "DEMO-1", "index.json"), "utf8")) as {
    latest: string;
  };
  return index.latest;
};

describe("start fresh and clean up (REQ-PRJ-07)", () => {
  it("REQ-PRJ-07/AC1: work reset closes the open work; commands stop continuing it and the next fetch starts a new run; --delete removes runs", async () => {
    const p = await setup();
    const first = await fetchRun(p);
    expect((await p.run(["status"])).out).toContain("DEMO-1  run");
    const reset = await p.run(["work", "reset", "DEMO-1"]);
    expect(reset.out).toContain("Work on DEMO-1 closed; 'qajitsu fetch DEMO-1' starts a new run.");
    expect((await p.run(["status"])).out).toContain("Work in progress: none");
    const plan = await p.run(["plan", "DEMO-1"]);
    expect(plan.exitCode).toBe(3);
    expect(plan.err).toContain("[RUN_CLOSED]");
    // The old run is still there and can be named explicitly; a fetch starts a new one.
    expect(await readdir(join(p.runs, "DEMO-1"))).toContain(first);
    const second = await fetchRun(p);
    expect(second).not.toBe(first);
    expect((await p.run(["status"])).out).toContain("fetched, no plan yet");
    const deleted = await p.run(["work", "reset", "DEMO-1", "--delete"]);
    expect(deleted.out).toContain(`removed DEMO-1/${first}`);
    expect(deleted.out).toContain(`removed DEMO-1/${second}`);
    expect((await readdir(join(p.runs, "DEMO-1"))).filter((f) => /^\d{8}-/.test(f))).toEqual([]);
    // Journals of deleted runs are archived (REQ-OBS-05/AC2).
    expect(await readdir(join(p.runs, ".audit", "DEMO-1"))).toEqual(
      expect.arrayContaining([`${first}.events.jsonl`, `${second}.events.jsonl`]),
    );
  }, 120_000);

  it("REQ-PRJ-07/AC2, REQ-PRJ-08/AC3: clean --project applies retention to all runs and git mirrors of the project", async () => {
    const p = await setup();
    await fetchRun(p);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      `${await readFile(yaml, "utf8")}\ncleanup: { policy: on_success, keep_last: 1, max_age_days: 1 }\n`,
    );
    await fetchRun(p);
    const mirror = join(p.projectHome, "cache", "git", "local", "demo-org", "demo-shop.git");
    const old = new Date(Date.now() - 10 * 86_400_000);
    await utimes(join(mirror, "FETCH_HEAD"), old, old).catch(() => utimes(mirror, old, old));
    await utimes(mirror, old, old);
    const dry = await p.run(["clean", "--project", "--dry-run"]);
    expect(dry.out).toMatch(/would remove DEMO-1\/\d{8}-/);
    expect(dry.out).toContain(`would remove git mirror ${mirror}`);
    const done = await p.run(["clean", "--project"]);
    expect(done.exitCode).toBe(0);
    expect(done.out).toContain(`removed git mirror ${mirror}`);
    expect((await readdir(join(p.runs, "DEMO-1"))).filter((f) => /^\d{8}-/.test(f))).toHaveLength(1);
    await expect(readdir(mirror)).rejects.toThrow();
    expect((await p.run(["clean"])).err).toContain("[TICKET_MISSING]");
  }, 120_000);

  it("REQ-PRJ-07/AC3+AC4: projects remove lists first, needs confirmation, keeps .qa/ and the run journals, and clears the active project", async () => {
    const p = await setup();
    const runId = await fetchRun(p);
    const dry = await p.run(["projects", "remove", "demo", "--dry-run"]);
    expect(dry.exitCode).toBe(0);
    expect(dry.out).toMatch(/Project demo: .*projects\/demo \(\d+\.\d MB\)/);
    expect(dry.out).toMatch(/runs\s+\d+ file\(s\)/);
    expect(dry.out).toContain("tickets with runs: 1");
    expect(await readdir(p.projectHome)).toContain("runs");
    const refused = await p.run(["projects", "remove", "demo"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("pass --yes");
    expect((await p.run(["projects", "remove", "demo"], undefined, { ask: ["shop"] })).exitCode).toBe(3);
    const removed = await p.run(["projects", "remove", "demo"], undefined, { ask: ["demo"] });
    expect(removed.exitCode).toBe(0);
    expect(removed.out).toContain("Project demo removed.");
    await expect(readdir(p.projectHome)).rejects.toThrow();
    expect(await readdir(join(p.project, ".qa"))).toContain("qa.project.yaml");
    expect(await readdir(join(p.home, ".qajitsu", "audit", "demo", "DEMO-1"))).toEqual([
      `${runId}.events.jsonl`,
    ]);
    expect((await p.run(["projects", "current"])).exitCode).toBe(3);
  }, 120_000);

  it("REQ-PRJ-07/AC5: archive hides a project from the list and its ticket prefix; unarchive brings it back", async () => {
    const p = await setup();
    expect((await p.run(["projects", "archive", "demo"])).out).toContain("Project demo archived");
    expect((await p.run(["projects", "list"])).out).toContain("No projects yet");
    expect((await p.run(["projects", "list", "--archived"])).out).toMatch(/demo {2}archived/);
    expect((await p.run(["fetch", "DEMO-1"])).err).toContain("[PROJECT_NOT_SELECTED]");
    await p.run(["projects", "unarchive", "demo"]);
    expect((await p.run(["fetch", "DEMO-1"])).out.split("\n")[0]).toBe("Project: demo (ticket prefix DEMO)");
  }, 120_000);
});
