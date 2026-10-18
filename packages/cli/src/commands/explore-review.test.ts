import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ReviewRecordSchema } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A recorded browser session S01 of the run, as `qj explore` writes it. */
export const SESSION = {
  schema: 1,
  id: "S01",
  ticket: "DEMO-1",
  run: "20261003-1046-aaaa",
  goal: "Cart around the discount change",
  environment: { name: "local", baseUrl: "http://127.0.0.1:3000" },
  model: "mock/scripted",
  startedAt: "2026-10-03T10:00:00Z",
  endedAt: "2026-10-03T10:05:00Z",
  endReason: "finished",
  budget: { minutes: 10, steps: 10 },
  summary: "",
  checklist: [
    { item: "open the cart", source: "person", actions: ["A01"] },
    { item: "apply a code twice", source: "person", actions: [], notDone: "the step budget was used" },
  ],
  findings: [{ text: "the total keeps three decimals after a discount", actions: ["A01"] }],
  actions: [
    {
      id: "A01",
      action: "goto",
      target: "/app/cart",
      ok: true,
      url: "http://127.0.0.1:3000/app/cart",
      at: "t",
    },
  ],
  observations: [
    {
      id: "O1",
      title: "Total has three decimals",
      kind: "possible-bug",
      severity: "medium",
      description: "The cart total shows 1.005.",
      steps: ["A01"],
      expected: "two decimals",
      actual: "1.005",
    },
  ],
  recordings: [],
};

export const writeSession = async (runDir: string, session: object = SESSION) => {
  await mkdir(join(runDir, "explore", "S01"), { recursive: true });
  await writeFile(join(runDir, "explore", "S01", "session.json"), `${JSON.stringify(session, null, 2)}\n`);
};

const setup = async () => {
  const p = await createDemoPipeline();
  cleanups.push(p.cleanup);
  await p.run(["fetch", "DEMO-1"]);
  await writeSession(p.runDir);
  return p;
};

describe("qajitsu explore review (REQ-PLAN-11)", () => {
  it("REQ-PLAN-11/AC1+AC2: lists the items, records decisions of a person with the session's hash, and journals them", async () => {
    const p = await setup();
    const listed = await p.run(["explore", "review", "DEMO-1"]);
    expect(listed.exitCode).toBe(0);
    expect(listed.out).toContain("S01: 3 item(s): 0 accepted, 0 rejected, 3 not reviewed");
    expect(listed.out).toContain("  O1 [not reviewed] observation: Total has three decimals");
    expect(listed.out).toContain(
      "  F1 [not reviewed] finding: the total keeps three decimals after a discount",
    );
    expect(listed.out).toContain("  C2 [not reviewed] not-done: apply a code twice");
    const decided = await p.run([
      "explore",
      "review",
      "DEMO-1",
      "--session",
      "S01",
      "--accept",
      "O1,C2",
      "--reject",
      "F1",
      "--note",
      "seen by hand too",
    ]);
    expect(decided.exitCode).toBe(0);
    expect(decided.out).toContain("S01: 3 item(s): 2 accepted, 1 rejected, 0 not reviewed");
    const review = ReviewRecordSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "explore", "S01", "review.json"), "utf8")),
    );
    expect(review.sessionSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(review.decisions.map((d) => [d.item, d.decision, d.by])).toEqual([
      ["O1", "accepted", "qa-lead"],
      ["C2", "accepted", "qa-lead"],
      ["F1", "rejected", "qa-lead"],
    ]);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toMatch(/"actor":\{"kind":"user","name":"qa-lead"\},"event":"explore.reviewed"/);
    expect(journal).toContain(review.sessionSha256);
    // REQ-PLAN-11/AC2: the session file changed: the decisions no longer count and the items are open again.
    await writeSession(p.runDir, { ...SESSION, summary: "edited afterwards" });
    const stale = await p.run(["explore", "review", "DEMO-1"]);
    expect(stale.out).toContain("S01: the session changed after 3 decision(s); they no longer count");
    expect(stale.out).toContain("S01: 3 item(s): 0 accepted, 0 rejected, 3 not reviewed");
  });

  it("REQ-PLAN-11/AC1: unknown items, an unknown session and a missing --session are refused; nothing is accepted by default", async () => {
    const p = await setup();
    const unknown = await p.run(["explore", "review", "DEMO-1", "--session", "S01", "--accept", "O9"]);
    expect(unknown.exitCode).toBe(3);
    expect(unknown.err).toContain("O9 is not an item of session S01 (items: O1, F1, C2)");
    expect((await p.run(["explore", "review", "DEMO-1", "--session", "S07"])).err).toContain(
      "EXPLORE_SESSION_NOT_FOUND",
    );
    expect((await p.run(["explore", "review", "DEMO-1", "--accept", "O1"])).err).toContain(
      "--accept, --reject and --keep need --session",
    );
    // Without a terminal and without flags nothing is decided.
    await p.run(["explore", "review", "DEMO-1"]);
    await expect(readFile(join(p.runDir, "explore", "S01", "review.json"), "utf8")).rejects.toThrow();
  });

  it("REQ-PLAN-11/AC3+AC6+AC7: qj plan offers the accepted items, marks cases from them and shows what no case covers", async () => {
    const p = await setup();
    await p.run(["explore", "review", "DEMO-1", "--session", "S01", "--accept", "O1,C2", "--reject", "F1"]);
    const [analysis, draft] = flowScript("DEMO-1");
    const plan = JSON.parse((draft as { text: string }).text) as { cases: { source: unknown[] }[] };
    plan.cases[0]?.source.push({ kind: "explore", session: "S01", item: "O1" });
    const r = await p.run(["plan", "DEMO-1"], {
      script: [analysis as never, { text: JSON.stringify(plan) }],
    });
    expect(r.err).toBe("");
    expect(r.out).toContain("Exploration: 2 accepted item(s) offered to the planner (S01: O1, C2)");
    expect(r.out).toContain("  S01/O1 → TC-01");
    expect(r.out).toMatch(/ {2}S01\/C2 → no case: open question Q\d+/);
    const md = await readFile(join(p.runDir, "plan", "plan.v1.md"), "utf8");
    expect(md).toContain("from exploration S01/O1 (accepted; report: explore/S01/report.html)");
  }, 120_000);

  it("REQ-PLAN-11/AC8: an accepted observation can be kept in the project's knowledge base; one not accepted cannot", async () => {
    const p = await setup();
    const refused = await p.run(["explore", "review", "DEMO-1", "--session", "S01", "--keep", "O1"]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("O1 is not accepted: only accepted items can be kept (add --accept O1)");
    const kept = await p.run([
      "explore",
      "review",
      "DEMO-1",
      "--session",
      "S01",
      "--accept",
      "O1",
      "--keep",
      "O1",
    ]);
    expect(kept.err).toBe("");
    const dir = /Kept in the knowledge base: S01\/O1 \((.+)\)/.exec(kept.out)?.[1] ?? "";
    expect(dir).toMatch(/[/\\]explore-notes$/);
    const note = await readFile(join(dir, "DEMO-1-S01-O1.md"), "utf8");
    expect(note).toContain("# Total has three decimals");
    expect(note).toContain("Ticket: DEMO-1");
    expect(note).toContain("Accepted by qa-lead");
    const listed = await p.run(["knowledge", "list"]);
    expect(listed.out).toMatch(/explore-notes.*tags exploration/);
    const search = await p.run(["knowledge", "search", "three decimals"]);
    expect(search.out).toContain("Total has three decimals");
    expect(await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8")).toContain(
      '"event":"explore.kept"',
    );
  }, 120_000);
});
