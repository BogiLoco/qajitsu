import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";
import { parseQjCommand } from "./ticket-approval.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const FLOW = [
  "workflow:",
  "  statuses: { start: 'Ready for QA', in_testing: 'In QA', waiting_for_approval: 'Plan review', needs_info: 'Needs info', passed: 'QA passed', failed: 'In development', needs_review: 'QA review' }",
  "  approvers_group: qa-leads",
  "  max_revisions: 1",
  "  remind_after_h: 24",
];

interface Flow {
  data: {
    approval?: { approver: string; version: number };
    ticketFlow: {
      commands: { command: string; account: string; outcome: string }[];
      revisions: number;
      rejected?: { reason: string };
    };
  };
}

/** A planned DEMO-1 run whose ticket answers with the given comments; anna is in qa-leads, mallory is not. */
const planned = async () => {
  let clock = new Date("2026-10-03T10:46:00Z");
  const p = await createDemoPipeline({ config: FLOW, ports: { now: () => clock } });
  cleanups.push(p.cleanup);
  const ticketFile = join(p.project, "tickets", "DEMO-1.json");
  await writeFile(
    join(p.project, "tickets", "workflow.json"),
    JSON.stringify({ groups: { "qa-leads": ["acc-anna"] } }),
  );
  await p.run(["fetch", "DEMO-1"]);
  const [analysis, draft] = flowScript("DEMO-1");
  await p.run(["plan", "DEMO-1"], { script: [analysis ?? { text: "" }, draft ?? { text: "" }] });
  const comment = async (id: string, who: "anna" | "mallory", body: string) => {
    const t = JSON.parse(await readFile(ticketFile, "utf8")) as { comments: unknown[] };
    t.comments.push({
      id,
      author: who === "anna" ? "Anna" : "Mallory",
      account: `acc-${who}`,
      body,
      created: clock.toISOString(),
    });
    await writeFile(ticketFile, JSON.stringify(t));
  };
  const record = async () => JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as Flow;
  const status = async () => (JSON.parse(await readFile(ticketFile, "utf8")) as { status: string }).status;
  const published = (name: string) =>
    readFile(join(p.runDir, "report", "published", `jira-comment.${name}.wiki.txt`), "utf8");
  return {
    ...p,
    comment,
    record,
    status,
    published,
    draft: draft && "text" in draft ? draft.text : "",
    advance: (hours: number) => {
      clock = new Date(clock.getTime() + hours * 3_600_000);
    },
  };
};

describe("plan approval in the ticket (REQ-FLOW-03)", () => {
  it("REQ-FLOW-03/AC1+AC3+AC4+AC7: posts the plan, ignores outsiders, refuses another version, freezes the one named", async () => {
    const p = await planned();
    const first = await p.run(["workflow", "sync", "DEMO-1"]);
    expect(first.exitCode).toBe(0);
    expect(first.out).toContain("Posted plan v1 to DEMO-1.");
    expect(await p.status()).toBe("Plan review");
    const plan = await p.published("plan-v1");
    expect(plan).toContain("QAJitsu test plan v1 for DEMO-1");
    expect(plan).toMatch(/TC-01 \[api, high\]/);
    expect(plan).toContain("/qj approve v1");

    await p.comment("c1", "mallory", "/qj approve v1");
    await p.comment("c2", "anna", "Looks fine.\n/qj approve v2");
    await p.comment("c3", "anna", "/qj approve v1");
    const synced = await p.run(["workflow", "sync", "DEMO-1"]);
    expect(synced.exitCode).toBe(0);
    expect(await p.published("reply-c1")).toContain("only members of qa-leads");
    expect(await p.published("reply-c2")).toContain("v2 is not the version waiting for approval (v1)");
    expect(await p.published("reply-c3")).toMatch(/Plan v1 approved; sha256 [0-9a-f]{64}/);
    const r = await p.record();
    expect(r.data.approval).toMatchObject({ version: 1, approver: "jira:Anna (acc-anna)" });
    expect(r.data.ticketFlow.commands.map((c) => [c.account, c.outcome])).toEqual([
      ["acc-mallory", "ignored: not in qa-leads"],
      ["acc-anna", "refused: v2 is not the version waiting for approval (v1)"],
      ["acc-anna", "approved v1"],
    ]);
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal.match(/"ticket\.command"/g)).toHaveLength(3);
    // A second sync acts on nothing twice.
    await p.run(["workflow", "sync", "DEMO-1"]);
    expect((await p.record()).data.ticketFlow.commands).toHaveLength(3);
    expect((await p.run(["audit", "verify", "DEMO-1"])).exitCode).toBe(0);
  });

  it("REQ-FLOW-03/AC2+AC6: revise posts the next version with a change list, stops after the limit; reject sends the ticket to needs info", async () => {
    const p = await planned();
    await p.run(["workflow", "sync", "DEMO-1"]);
    const draft = JSON.parse(p.draft) as { cases: { id: string }[] };
    const revised = JSON.stringify({ ...draft, cases: draft.cases.filter((c) => c.id !== "TC-02") });
    await p.comment("c1", "anna", "/qj revise drop TC-02, it duplicates TC-01");
    await p.comment("c2", "anna", "/qj revise add a negative case");
    await p.comment("c3", "anna", "/qj reject the ticket needs real criteria first");
    await p.comment("c4", "anna", "/qj approve v2");
    const r = await p.run(["workflow", "sync", "DEMO-1"], { script: [{ text: revised }] });
    expect(r.exitCode).toBe(0);
    const v2 = await p.published("plan-v2");
    expect(v2).toContain("Changes since v1:");
    expect(v2).toContain("removed TC-02");
    expect(await p.published("reply-c2")).toContain(
      "1 revision rounds already. Please edit the plan directly",
    );
    expect(await p.published("reply-c3")).toContain("Plan rejected: the ticket needs real criteria first.");
    expect(await p.status()).toBe("Needs info");
    const flow = (await p.record()).data;
    expect(flow.approval).toBeUndefined();
    expect(flow.ticketFlow.revisions).toBe(1);
    expect(flow.ticketFlow.rejected?.reason).toBe("the ticket needs real criteria first");
    expect(flow.ticketFlow.commands.map((c) => c.outcome)).toEqual([
      "revised to v2",
      "refused: revision limit",
      "rejected",
      "ignored: rejected",
    ]);
  });

  it("REQ-FLOW-03/AC5: silence is never approval: a reminder after the configured time, the plan stays unapproved", async () => {
    const p = await planned();
    await p.run(["workflow", "sync", "DEMO-1"]);
    p.advance(23);
    expect((await p.run(["workflow", "sync", "DEMO-1"])).out).not.toContain("Reminded");
    p.advance(2);
    expect((await p.run(["workflow", "sync", "DEMO-1"])).out).toContain(
      "Reminded DEMO-1: plan v1 is waiting for approval.",
    );
    expect(await p.published("reminder-1")).toContain("nothing runs until then");
    // The next reminder waits for another full period.
    expect((await p.run(["workflow", "sync", "DEMO-1"])).out).not.toContain("Reminded");
    expect((await p.record()).data.approval).toBeUndefined();
    expect((await p.run(["run", "DEMO-1"])).exitCode).not.toBe(0);
  });

  it("REQ-FLOW-03/AC2: only a /qj command at the start of a line counts, never inside QAJitsu's own comments", () => {
    expect(parseQjCommand("/qj approve v3")).toEqual({ name: "approve", text: "v3", version: 3 });
    expect(parseQjCommand("ok\n  /qj revise add a case for 0 items")).toEqual({
      name: "revise",
      text: "add a case for 0 items",
    });
    expect(parseQjCommand("/qj reject   no criteria")).toEqual({ name: "reject", text: "no criteria" });
    expect(parseQjCommand("/qj approve")).toEqual({ name: "approve", text: "" });
    expect(parseQjCommand("please /qj approve v1")).toBeUndefined();
    expect(parseQjCommand("QAJitsu test plan v1\n/qj approve v1")).toBeUndefined();
    expect(parseQjCommand("/qjapprove v1")).toBeUndefined();
  });
});
