// Adversarial suite: someone changes the record of a run after the fact to hide what the agents did.
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const executedRun = async () => {
  const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING" });
  cleanups.push(p.cleanup);
  await p.executed();
  expect((await p.run(["audit", "trail", "DEMO-1"])).exitCode).toBe(0);
  return p;
};

describe("the audit trail cannot be made to look complete (REQ-VER-16/AC4)", () => {
  it("REQ-VER-16/AC4: deleting the agent transcript to hide the prompts is a gap", async () => {
    const p = await executedRun();
    await rm(join(p.runDir, "journal", "agents.jsonl"));
    const r = await p.run(["audit", "trail", "DEMO-1"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/journal\/agents.jsonl is missing \(\d+ model calls\)/);
  }, 180_000);

  it("REQ-VER-16/AC4: dropping one exchange and its hash from the journal breaks the hash chain", async () => {
    const p = await executedRun();
    const events = join(p.runDir, "journal", "events.jsonl");
    const lines = (await readFile(events, "utf8")).trim().split("\n");
    const usage = lines.findIndex((l) => l.includes('"model.usage"'));
    await writeFile(events, `${lines.filter((_, i) => i !== usage).join("\n")}\n`);
    const r = await p.run(["audit", "trail", "DEMO-1"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toContain("does not match the previous line");
    expect(r.out).toContain("not referenced by the journal");
  }, 180_000);

  it("REQ-VER-16/AC4: a trail.json edited to say complete changes nothing: the trail is always recomputed", async () => {
    const p = await executedRun();
    await writeFile(join(p.runDir, "evidence", "manifest.json"), "[]");
    await writeFile(join(p.runDir, "audit", "trail.json"), '{"complete":true,"gaps":[]}');
    const r = await p.run(["audit", "trail", "DEMO-1"]);
    expect(r.exitCode).toBe(1);
    expect(r.out).toMatch(/evidence\/TC-01\/attempt-1\/[^ ]+ is not in the evidence manifest/);
  }, 180_000);
});
