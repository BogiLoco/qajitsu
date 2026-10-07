import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEventLines, PlanSchema, sha256 } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { packCasesSha256 } from "./pack.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const fixture = (path: string) => new URL(`../../../../fixtures/${path}`, import.meta.url);
const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  ...JSON.parse(readFileSync(fixture("plans/demo-1-draft.json"), "utf8")),
});

/** A pack as `qj promote` writes it, in `<tests>/tests/qajitsu/DEMO-1/`. */
const writePack = async (
  edit: (pack: Record<string, unknown>) => void = () => undefined,
): Promise<{ root: string; dir: string }> => {
  const root = await mkdtemp(join(tmpdir(), "qj-packs-"));
  const dir = join(root, "tests", "qajitsu", "DEMO-1");
  await mkdir(dir, { recursive: true });
  const specs: Record<string, string> = {};
  for (const c of plan.cases) {
    const text = readFileSync(fixture(`specs/demo-1/${c.id}.spec.ts`), "utf8");
    await writeFile(join(dir, `${c.id}.qajitsu.ts`), text);
    specs[c.id] = sha256(text);
  }
  const pack: Record<string, unknown> = {
    schema: 1,
    kind: "qajitsu-regression-pack",
    ticket: "DEMO-1",
    run: "20261001-0900-abcd",
    plan: { version: 1, sha256: "a".repeat(64), approved_by: "qa-lead", approved_at: "2026-10-01T09:00:00Z" },
    promoted_by: "qa-lead",
    promoted_at: "2026-10-01T10:00:00Z",
    specs,
    cases_sha256: packCasesSha256(plan.cases),
    // A copy: a test that edits the pack must not change the plan other tests use.
    cases: structuredClone(plan.cases),
  };
  edit(pack);
  await writeFile(join(dir, "expectations.yaml"), stringify(pack, { lineWidth: 0 }));
  return { root, dir };
};

const setup = async (flag?: string) => {
  const p = await createDemoPipeline(flag ? { flag } : {});
  cleanups.push(p.cleanup);
  const reports = async () => {
    const base = join(p.home, ".qajitsu", "projects", "demo", "exports", "regression");
    const [stamp] = await readdir(base);
    return join(base, stamp ?? "");
  };
  return { ...p, reports };
};

describe("qj regression (REQ-EXEC-17)", () => {
  it("REQ-EXEC-17/AC1+AC3: runs promoted packs with the sandboxed runners and no model; the suite report covers every case", async () => {
    const p = await setup();
    const { root } = await writePack();
    const r = await p.run(["regression", "--from", root]);
    expect(r.err).toBe("");
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("== Regression pack DEMO-1 (tests/qajitsu/DEMO-1)");
    expect(r.out).toContain("**NO REGRESSIONS: 2 case(s) in 1 pack(s): 2 PASSED.**");
    const dir = await p.reports();
    expect((await readdir(dir)).sort()).toEqual(["junit.xml", "regression.md", "report.html"]);
    expect(await readFile(join(dir, "junit.xml"), "utf8")).toContain(
      '<testsuite name="regression DEMO-1" tests="2" failures="0"',
    );
    // The pack's run: its plan is the pack, approved in the pack's name; no agent or model took part.
    const runs = join(p.home, "runs", "DEMO-1");
    const runId = (await readdir(runs)).find((n) => /^\d{8}-/.test(n)) ?? "";
    const record = JSON.parse(await readFile(join(runs, runId, "run.json"), "utf8")) as {
      data: { regression: { promotedFrom: string }; approval: { approver: string } };
    };
    expect(record.data.regression.promotedFrom).toBe("20261001-0900-abcd");
    expect(record.data.approval.approver).toBe("qa-lead (regression pack 20261001-0900-abcd)");
    const { events } = parseEventLines(await readFile(join(runs, runId, "journal", "events.jsonl"), "utf8"));
    expect(events.filter((e) => e.actor.kind === "agent" || e.event === "model.usage")).toEqual([]);
  }, 240_000);

  it("REQ-EXEC-17/AC3+AC4: a case that passed when promoted and fails now is a regression; exit 1", async () => {
    const p = await setup("BUG_CART_TOTAL_ROUNDING");
    const { root } = await writePack();
    const r = await p.run(["regression", "--from", root]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("**1 REGRESSION(S): 2 case(s) in 1 pack(s): 1 PASSED, 1 FAILED.**");
    expect(r.out).toMatch(
      /- DEMO-1 TC-01 FAILED: Cart total is rounded once \(S1 fields\.total: expected 1\.01, actual 1\.0\d\)/,
    );
    expect(await readFile(join(await p.reports(), "junit.xml"), "utf8")).toContain("<failure message=");
  }, 240_000);

  it("REQ-EXEC-17/AC2: a changed spec or changed expected values make the cases BLOCKED, never PASSED", async () => {
    const p = await setup();
    const spec = await writePack();
    await writeFile(
      join(spec.dir, "TC-02.qajitsu.ts"),
      "// edited\n" + (await readFile(join(spec.dir, "TC-02.qajitsu.ts"), "utf8")),
    );
    const r = await p.run(["regression", "--from", spec.root]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain(
      "- DEMO-1 TC-02 BLOCKED: Second code replaces the first (TC-02.qajitsu.ts changed since the pack was promoted)",
    );
    expect(r.out).toMatch(/\| DEMO-1 \| TC-01 \| .* \| PASSED \|/);

    const expected = await writePack((pack) => {
      // Someone "fixes" the expected total in the pack instead of the plan.
      (
        pack["cases"] as { steps: { expect: { fields?: Record<string, unknown> } }[] }[]
      )[0]!.steps[0]!.expect.fields = { total: 1.02 };
    });
    // Each regression run is a new run of DEMO-1; the test clock and random give one run id per project.
    const p2 = await setup();
    const r2 = await p2.run(["regression", "--from", expected.root]);
    expect(r2.exitCode).toBe(2);
    expect(r2.out).toContain("2 BLOCKED");
    expect(r2.out).toContain("the expected values in expectations.yaml changed since the pack was promoted");

    const noHash = await writePack((pack) => {
      delete pack["cases_sha256"];
    });
    const p3 = await setup();
    const r3 = await p3.run(["regression", "--from", noHash.root]);
    expect(r3.out).toContain("records no hash of its expected values (cases_sha256); promote it again");
  }, 240_000);

  it("REQ-EXEC-17/AC1: invalid packs are reported, unknown tickets are filtered, an empty folder is not a pass", async () => {
    const p = await setup();
    const { root } = await writePack();
    await mkdir(join(root, "tests", "qajitsu", "BROKEN-1"), { recursive: true });
    await writeFile(
      join(root, "tests", "qajitsu", "BROKEN-1", "expectations.yaml"),
      "kind: qajitsu-regression-pack\nschema: 1\n",
    );
    await writeFile(join(root, "tests", "other.yaml"), "kind: something-else\n");
    const r = await p.run(["regression", "--from", root]);
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain("## Packs that could not run");
    expect(r.out).toMatch(/- tests\/qajitsu\/BROKEN-1: expectations.yaml is not a valid pack: /);
    const none = await p.run(["regression", "--from", root, "--packs", "DEMO-9"]);
    expect(none.exitCode).toBe(2);
    expect(none.err).toContain("No regression packs found in");
    const empty = await mkdtemp(join(tmpdir(), "qj-empty-"));
    expect((await p.run(["regression", "--from", empty])).exitCode).toBe(2);
  }, 240_000);

  it("REQ-EXEC-17/AC4: the report is published to a ticket only after confirmation", async () => {
    const p = await setup();
    const { root } = await writePack();
    const quiet = await p.run(["regression", "--from", root, "--publish", "DEMO-100"]);
    expect(quiet.exitCode).toBe(2);
    expect(quiet.err).toContain("Not interactive: not published; confirm with --yes.");
    const p2 = await setup();
    const ok = await p2.run(["regression", "--from", root, "--publish", "DEMO-100", "--yes"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.out).toMatch(/Published regression report on DEMO-100: comment local-\d{8}-\d{4}-regr/);
    const bases = join(p2.home, ".qajitsu", "projects", "demo", "exports", "regression");
    const published = [];
    for (const stamp of await readdir(bases))
      published.push(...(await readdir(join(bases, stamp)).catch(() => [])).filter((f) => f === "published"));
    expect(published).toEqual(["published"]);
    const bad = await p.run(["regression", "--from", root, "--publish", "nope"]);
    expect(bad.err).toContain("[TICKET_KEY_INVALID]");
  }, 240_000);
});
