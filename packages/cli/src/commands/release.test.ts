import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** Adds release fields to a file ticket of the project (and creates DEMO-2 without a run). */
const tagTickets = async (project: string) => {
  const file = join(project, "tickets", "DEMO-1.json");
  const t = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  await writeFile(file, JSON.stringify({ ...t, fixVersions: ["2.4"], sprint: "Sprint 12" }));
  await writeFile(
    join(project, "tickets", "DEMO-2.json"),
    JSON.stringify({ ...t, key: "DEMO-2", summary: "Checkout address", fixVersions: ["2.4"] }),
  );
};

describe("qj release (REQ-PUB-09)", () => {
  it("REQ-PUB-09/AC1+AC2+AC3: latest executed runs per ticket; FAILED is open, a ticket without a run is never ready", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.prepare();
    await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"]);
    await tagTickets(p.project);

    const r = await p.run(["release", "2.4"]);
    expect(r.err).toBe("");
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("# Release readiness: fix version 2.4");
    expect(r.out).toContain("NOT READY: 0 of 2 ticket(s) ready, 1 not ready, 1 without a run.");
    expect(r.out).toMatch(
      /\| DEMO-1 \| Cart total with discount codes \| Ready for QA \| not ready \| \d{8}-\d{4}-[a-z0-9]{4} \| 1 PASSED, 1 FAILED \|/,
    );
    expect(r.out).toContain("| DEMO-2 | Checkout address | Ready for QA | no run | – | – |");
    expect(r.out).toContain("- DEMO-1 TC-01 FAILED: Cart total is rounded once");
    expect(r.out).toContain("- DEMO-2: no executed run; not tested.");
    const report = join(p.home, ".qajitsu", "projects", "demo", "exports", "releases", "2.4.md");
    expect(await readFile(report, "utf8")).toContain("NOT READY");

    // By sprint only DEMO-1 belongs; an unknown version has no tickets and is not ready either.
    const sprint = await p.run(["release", "Sprint 12", "--sprint"]);
    expect(sprint.out).toContain("# Release readiness: sprint Sprint 12");
    expect(sprint.out).toContain("0 of 1 ticket(s) ready");
    expect(await readdir(join(p.home, ".qajitsu", "projects", "demo", "exports", "releases"))).toContain(
      "sprint-Sprint-12.md",
    );
    const none = await p.run(["release", "9.9"]);
    expect(none.exitCode).toBe(1);
    expect(none.out).toContain("NOT READY: 0 of 0 ticket(s) ready (no tickets found).");
  }, 240_000);

  it("REQ-PUB-09/AC3: a run whose results changed after the run is untrusted, not ready", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await p.run(["run", "DEMO-1", "--build"]);
    await tagTickets(p.project);
    await writeFile(join(p.project, "tickets", "DEMO-2.json"), "{}");
    const before = await p.run(["release", "Sprint 12", "--sprint"]);
    expect(before.out).toContain("READY: 1 of 1 ticket(s) ready.");
    expect(before.exitCode).toBe(0);

    // An evidence file changed after the run: its SHA-256 no longer matches the manifest, so the gates fail.
    const attempt = join(dir, "evidence", "TC-01", "attempt-1");
    const first = (await readdir(attempt)).sort()[0] ?? "";
    await writeFile(join(attempt, first), "{}");
    const after = await p.run(["release", "Sprint 12", "--sprint"]);
    expect(after.exitCode).toBe(1);
    expect(after.out).toContain("0 of 1 ticket(s) ready, 1 untrusted.");
    expect(after.out).toMatch(/- DEMO-1 run \d{8}-\d{4}-[a-z0-9]{4}: publish gates failed: /);
  }, 240_000);

  it("REQ-PUB-09/AC4: published to a ticket only after confirmation; publishing again updates the comment", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    await p.prepare();
    await p.run(["run", "DEMO-1", "--build"]);
    await tagTickets(p.project);
    const published = join(p.home, ".qajitsu", "projects", "demo", "exports", "releases", "published");

    const quiet = await p.run(["release", "2.4", "--publish", "DEMO-100"]);
    expect(quiet.exitCode).toBe(2);
    expect(quiet.err).toContain("Not interactive: not published; confirm with --yes.");
    expect(await readdir(published).catch(() => [])).toEqual([]);
    const declined = await p.run(["release", "2.4", "--publish", "DEMO-100"], undefined, { ask: ["n"] });
    expect(declined.exitCode).toBe(2);
    expect(declined.err).toContain("Not published.");

    const ok = await p.run(["release", "2.4", "--publish", "DEMO-100"], undefined, { ask: ["y"] });
    expect(ok.err).toBe("");
    expect(ok.exitCode).toBe(1);
    expect(ok.out).toMatch(/Published release report on DEMO-100: comment local-\d{8}-\d{4}-rels/);
    const wiki = await readFile(join(published, "jira-comment.wiki.txt"), "utf8");
    expect(wiki).toContain("h3. Release readiness: fix version 2.4");
    expect(wiki).toContain("* DEMO\\-2: no executed run; not tested.");
    const again = await p.run(["release", "2.4", "--publish", "DEMO-100", "--yes"]);
    expect(again.out).toContain("Updated release report on DEMO-100");

    const bad = await p.run(["release", "2.4", "--publish", "not a key"]);
    expect(bad.exitCode).toBe(3);
    expect(bad.err).toContain("[TICKET_KEY_INVALID]");
  }, 240_000);
});
