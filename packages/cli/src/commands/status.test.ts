import { copyFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { registerProject } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { PASSWORD, analysis, createBuildProject, draft } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});
const setup = async () => {
  const p = await createBuildProject();
  cleanups.push(p.cleanup);
  return p;
};
/** Work in progress lines of `qj status`, without the run id. */
const work = (out: string) =>
  out
    .split("\n")
    .filter((l) => /^ {2}DEMO-|^ {6}(next|note)/.test(l))
    .map((l) => l.replace(/run \d{8}-\d{4}-[a-z0-9]{4}/g, "run <id>").trim());

describe("qajitsu status, note and resume (REQ-PRJ-05, REQ-PRJ-06)", () => {
  it("REQ-PRJ-05/AC1+AC2+AC3 + REQ-PRJ-06/AC2: shows readiness, environment, knowledge and each stage of the work with the next command, from the run folders", async () => {
    const p = await setup();
    const status = async () => (await p.run(["status"])).out;
    expect(await status()).toContain("Work in progress: none");
    await p.run(["fetch", "DEMO-1"]);
    let out = await status();
    expect(out).toMatch(/^Configuration: (ready|not ready)/m);
    expect(out).toContain("Default environment:");
    expect(out).toContain("Knowledge base: empty (add documents with 'qajitsu knowledge add')");
    expect(work(out)).toEqual([
      "DEMO-1  run <id>  fetched, no plan yet",
      "next: qajitsu plan DEMO-1 --run <id>",
    ]);
    // A new process (another terminal, after a restart) sees the same state: everything is on disk.
    await p.run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }]);
    expect(work(await status())[0]).toBe("DEMO-1  run <id>  plan v1 waiting for approval");
    await p.run(["approve", "DEMO-1"]);
    expect(work(await status())).toEqual([
      "DEMO-1  run <id>  plan approved, not run",
      "next: qajitsu run DEMO-1 --run <id>",
    ]);
    const index = JSON.parse(await readFile(join(p.home, "runs", "DEMO-1", "index.json"), "utf8")) as {
      latest: string;
    };
    for (const id of ["TC-01", "TC-02"])
      await copyFile(
        new URL(`../../../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url),
        join(p.home, "runs", "DEMO-1", index.latest, "specs", `${id}.spec.ts`),
      );
    expect((await p.run(["run", "DEMO-1", "--build"])).exitCode).toBe(0);
    out = await status();
    expect(work(out)[0]).toMatch(/^DEMO-1 {2}run <id> {2}results not published \(.*\)$/);
    expect(work(out)[1]).toBe("next: qajitsu publish DEMO-1 --run <id>");
    expect((await p.run(["publish", "DEMO-1", "--auto-publish"])).exitCode).toBe(0);
    out = await status();
    expect(out).toContain("Work in progress: none");
    expect(out).toContain("Done: 1 ticket(s)");
    // REQ-PRJ-05/AC3: context.json is only an index of this, rebuilt on demand.
    const context = JSON.parse(
      await readFile(join(p.home, ".qajitsu", "projects", "demo", "context.json"), "utf8"),
    ) as { done: number; open: unknown[] };
    expect(context).toMatchObject({ done: 1, open: [] });
    expect((await p.run(["status", "--rebuild"])).out).toContain("context.json rebuilt");
  }, 180_000);

  it("REQ-PRJ-05/AC4: notes are kept with the ticket, shown in status, and secrets in them are masked", async () => {
    const p = await setup();
    await p.run(["fetch", "DEMO-1"]);
    expect((await p.run(["note", "DEMO-1", "waiting for test data from Anna"])).exitCode).toBe(0);
    await p.run(["note", "DEMO-1", `login works with ${PASSWORD}`]);
    const out = (await p.run(["status"])).out;
    expect(out).toContain("note (");
    expect(out).toContain("waiting for test data from Anna");
    expect(out).not.toContain(PASSWORD);
    expect(await readFile(join(p.home, "runs", "DEMO-1", "notes.json"), "utf8")).not.toContain(PASSWORD);
    expect((await p.run(["note", "DEMO-1", "  "])).exitCode).toBe(3);
  }, 120_000);

  it("REQ-PRJ-05/AC5 + REQ-PRJ-06/AC1: status --all covers every project; resume without a ticket lists resumable work", async () => {
    const p = await setup();
    await p.run(["fetch", "DEMO-1"]);
    const resumable = await p.run(["resume"]);
    expect(resumable.out).toContain("DEMO-1: fetched, no plan yet");
    expect(resumable.out).toMatch(/qajitsu plan DEMO-1 --run \d{8}-\d{4}-[a-z0-9]{4}/);
    const other = join(p.home, "other", ".qa");
    const { mkdir, writeFile } = await import("node:fs/promises");
    await mkdir(other, { recursive: true });
    await writeFile(
      join(other, "qa.project.yaml"),
      "project: other\njira: { type: file, tickets_dir: t, project_key: OTH }\n",
    );
    await registerProject(join(p.home, ".qajitsu"), { slug: "other", qaDir: other, jiraPrefixes: ["OTH"] });
    const all = (await p.run(["status", "--all"])).out;
    expect(all).toContain("== demo ==");
    expect(all).toContain("== other ==");
    expect(all).toContain("DEMO-1  run");
  }, 120_000);

  it("REQ-PRJ-06/AC3: after approval, a changed environment or secret stops the run until a person confirms it", async () => {
    const p = await setup();
    const dir = await p.prepare();
    const profile = join(p.project, ".qa", "envs", "local.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(profile, `${await readFile(profile, "utf8")}flags: { new_checkout: true }\n`);
    const ci = await p.run(["run", "DEMO-1", "--build"]);
    expect(ci.exitCode).toBe(3);
    expect(ci.err).toContain("[RUN_CONTEXT_CHANGED]");
    expect(ci.err).toContain("The environment changed since the plan was approved");
    // A rotated secret is noticed too; only its HMAC is compared, never stored in the run.
    const rotated = await p.run(["run", "DEMO-1", "--build"], undefined, {
      env: { DEMO_USER_PASSWORD: "rotated-fictional-password" },
    });
    expect(rotated.err).toContain("The environment and secrets changed");
    expect(await readFile(join(dir, "run.json"), "utf8")).not.toContain("rotated-fictional-password");
    // Interactively a person confirms and the run continues; the confirmation is journaled.
    const confirmed = await p.run(["run", "DEMO-1", "--build"], undefined, { ask: ["y"] });
    expect(confirmed.exitCode).toBe(0);
    expect(await readFile(join(dir, "journal", "events.jsonl"), "utf8")).toContain(
      '"approval.context_reconfirmed"',
    );
  }, 180_000);
});
