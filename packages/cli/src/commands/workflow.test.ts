import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { verdictTarget } from "./workflow.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const FLOW = [
  "workflow:",
  "  statuses: { start: 'Ready for QA', in_testing: 'In QA', needs_info: 'Needs info', passed: 'QA passed', failed: 'In development', needs_review: 'QA review' }",
  "  qa_assignee: qa-anna",
  "  authors: { dev-bob: acc-bob }",
];

const pipeline = async (flag?: string, config: readonly string[] = FLOW) => {
  // The first run is 20261003-1046-aaaa; once it exists, later fetches get other run ids.
  let runDir = "";
  let n = 0;
  const random = () => (runDir !== "" && existsSync(runDir) ? ((n++ * 0.37) % 0.98) + 0.01 : 0);
  const p = await createDemoPipeline({ ...(flag ? { flag } : {}), config, ports: { random } });
  runDir = p.runDir;
  cleanups.push(p.cleanup);
  return p;
};
const ticketIn = async (project: string) =>
  JSON.parse(await readFile(join(project, "tickets", "DEMO-1.json"), "utf8")) as {
    status: string;
    assignee?: string;
    labels: string[];
  };

describe("ticket workflow (REQ-FLOW-02, REQ-FLOW-04)", () => {
  it("REQ-FLOW-04/AC1: every case PASSED moves the ticket to the passed status, never to done by default", async () => {
    const p = await pipeline();
    expect((await p.executed()).exitCode).toBe(0);
    const r = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('Moved DEMO-1 to "QA passed"');
    expect((await ticketIn(p.project)).status).toBe("QA passed");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"ticket.transition"');
  });

  it("REQ-FLOW-04/AC2: a FAILED case sends the ticket back to development, assigned to the change's author", async () => {
    const p = await pipeline("BUG_CART_TOTAL_ROUNDING");
    expect((await p.executed()).exitCode).toBe(1);
    const changes = join(p.runDir, "repos", "changes.json");
    const found = JSON.parse(await readFile(changes, "utf8")) as { changes: { change: object }[] };
    for (const c of found.changes) Object.assign(c.change, { author: "dev-bob" });
    await writeFile(changes, JSON.stringify(found));
    const r = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(r.exitCode).toBe(0);
    const t = await ticketIn(p.project);
    expect(t.status).toBe("In development");
    expect(t.assignee).toBe("acc-bob");
  });

  it("REQ-FLOW-02/AC3: without a transition the ticket stays, a comment says why and the result is still published", async () => {
    const p = await pipeline();
    await p.executed();
    // The team's workflow allows nothing out of "Ready for QA".
    await writeFile(
      join(p.project, "tickets", "workflow.json"),
      JSON.stringify({ transitions: { "Ready for QA": [] } }),
    );
    const r = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain("Published DEMO-1 comment");
    expect(r.err).toContain("DEMO-1 stays where it is");
    expect((await ticketIn(p.project)).status).toBe("Ready for QA");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toMatch(/"ticket\.transition".*"moved":false/);
  });

  it("REQ-FLOW-02/AC1: a project without a workflow mapping never moves the ticket", async () => {
    const p = await pipeline(undefined, []);
    await p.executed();
    const r = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(r.exitCode).toBe(0);
    expect(r.out).not.toContain("Moved");
    expect((await ticketIn(p.project)).status).toBe("Ready for QA");
  });

  it("REQ-FLOW-02/AC2: qj doctor names a mapped status the workflow does not have", async () => {
    const p = await pipeline();
    await writeFile(
      join(p.project, "tickets", "workflow.json"),
      JSON.stringify({
        transitions: { "Ready for QA": ["In QA"], "In QA": ["QA passed", "In development"] },
      }),
    );
    const r = await p.run(["doctor"]);
    expect(r.out).toMatch(/workflow.*needs_info "Needs info" is not a status of DEMO/);
  });

  it("REQ-PLAN-13/AC2: a ticket that fails the readiness gate moves to the needs info status", async () => {
    const p = await pipeline();
    const file = join(p.project, "tickets", "DEMO-1.json");
    const ticket = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...ticket, acceptanceCriteria: [] }));
    await p.run(["fetch", "DEMO-1"]);
    const analysis = {
      text: JSON.stringify({
        summary: "Cart total with discount codes.",
        change_type: ["api"],
        endpoints: [
          {
            method: "GET",
            path: "/cart",
            source: [{ kind: "quote", text: "Cart total with discount codes" }],
          },
        ],
        confidence: "high",
      }),
    };
    const r = await p.run(["plan", "DEMO-1"], { script: [analysis] });
    expect(r.exitCode).toBe(2);
    expect(r.out).toContain('Moved DEMO-1 to "Needs info" (readiness NEEDS_CLARIFICATION)');
    expect((await ticketIn(p.project)).status).toBe("Needs info");
  });

  it("REQ-FLOW-04/AC3: a case that needs a person keeps the ticket in testing, labelled and assigned to QA", async () => {
    const p = await createDemoPipeline({
      config: FLOW,
      transformSpec: (id, code) =>
        id === "TC-01"
          ? code.replace(
              "await shopper.post(",
              'throw new Error("the cart service did not start");\n    await shopper.post(',
            )
          : code,
    });
    cleanups.push(p.cleanup);
    await p.executed();
    const r = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(r.exitCode).toBe(0);
    const t = await ticketIn(p.project);
    expect(t.status).toBe("In QA");
    expect(t.labels).toContain("qa-needs-attention");
    expect(t.assignee).toBe("qa-anna");
  });

  it("REQ-FLOW-05/AC1: while a run of the ticket is active a new event is ignored and logged", async () => {
    const p = await pipeline();
    await p.run(["fetch", "DEMO-1"]);
    // A live process (this one) holds the run.
    await writeFile(join(p.runDir, "run.lock"), `${String(process.pid)}\n`);
    const again = await p.run(["fetch", "DEMO-1"]);
    expect(again.exitCode).toBe(0);
    expect(again.out).toContain("Run 20261003-1046-aaaa of DEMO-1 is still active; this event is ignored.");
    const index = JSON.parse(await readFile(join(dirname(p.runDir), "index.json"), "utf8")) as {
      runs: unknown[];
    };
    expect(index.runs).toHaveLength(1);
    expect(await readFile(join(dirname(p.runDir), "flow.jsonl"), "utf8")).toContain('"reason":"active"');
    // A dead holder does not block: the crashed run is not active.
    await writeFile(join(p.runDir, "run.lock"), "999999\n");
    expect((await p.run(["fetch", "DEMO-1"])).out).toContain("Run ");
    const after = JSON.parse(await readFile(join(dirname(p.runDir), "index.json"), "utf8")) as {
      runs: unknown[];
    };
    expect(after.runs).toHaveLength(2);
  });

  it("REQ-FLOW-05/AC2: after the daily limit the ticket goes to human review instead of another run", async () => {
    const p = await pipeline(undefined, [...FLOW, "  max_runs_per_day: 2"]);
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const third = await p.run(["fetch", "DEMO-1"]);
    expect(third.exitCode).toBe(2);
    expect(third.err).toContain("DEMO-1 had 2 runs today (limit 2): no new run; it needs a person.");
    expect((await ticketIn(p.project)).status).toBe("QA review");
  });

  it("REQ-FLOW-05/AC1: without a workflow mapping parallel runs of a ticket stay allowed (REQ-WS-04/AC2)", async () => {
    const p = await pipeline(undefined, []);
    await p.run(["fetch", "DEMO-1"]);
    await writeFile(join(p.runDir, "run.lock"), `${String(process.pid)}\n`);
    expect((await p.run(["fetch", "DEMO-1"])).out).not.toContain("still active");
  });

  it("REQ-FLOW-04/AC4: only computed statuses decide where the ticket goes", () => {
    expect(verdictTarget(["PASSED", "PASSED"], false).role).toBe("passed");
    expect(verdictTarget(["PASSED"], true).role).toBe("done");
    expect(verdictTarget(["PASSED", "FAILED", "BLOCKED"], true).role).toBe("failed");
    expect(verdictTarget(["PASSED", "NEEDS_REVIEW"], true).role).toBe("in_testing");
    expect(verdictTarget(["PASSED", "FLAKY"], true).role).toBe("in_testing");
    expect(verdictTarget(["NOT_RUN"], true).role).toBe("in_testing");
    expect(verdictTarget([], true).role).toBe("needs_review");
  });
});
