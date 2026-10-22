import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("ticket readiness gate in qj plan (REQ-PLAN-13)", () => {
  it("REQ-PLAN-13/AC1+AC2+AC3+AC4: a ticket without criteria gets questions instead of a plan, posted to the ticket; a person can plan anyway, recorded", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    const ticketFile = join(p.project, "tickets", "DEMO-1.json");
    const ticket = JSON.parse(await readFile(ticketFile, "utf8")) as Record<string, unknown>;
    await writeFile(ticketFile, JSON.stringify({ ...ticket, acceptanceCriteria: [], labels: ["payments"] }));
    await p.run(["fetch", "DEMO-1"]);
    // The analysis cites the ticket's own text: there is no criterion left to cite.
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
    const stopped = await p.run(["plan", "DEMO-1"], { script: [analysis] });
    expect(stopped.exitCode).toBe(2);
    expect(stopped.out).toContain("Readiness: NEEDS_CLARIFICATION · risk high");
    expect(stopped.out).toContain('  risk high: the ticket is marked "payments"');
    expect(stopped.out).toContain(
      "  1. What must be true when this ticket is done? Please add acceptance criteria.",
    );
    expect(stopped.out).toContain('plan anyway with --override-readiness "<reason>"');
    const readiness = JSON.parse(await readFile(join(p.runDir, "readiness.json"), "utf8")) as Record<
      string,
      unknown
    >;
    expect(readiness).toMatchObject({
      result: "NEEDS_CLARIFICATION",
      risk: "high",
      gaps: ["no acceptance criteria"],
    });
    expect(
      await readFile(join(p.runDir, "report", "published", "jira-comment.readiness.wiki.txt"), "utf8"),
    ).toContain("Questions before testing:");
    // Asking again without an override does not plan either.
    expect((await p.run(["plan", "DEMO-1"], { script: [analysis] })).exitCode).toBe(2);

    const draft = {
      text: JSON.stringify({
        summary: "Cart total.",
        cases: [
          {
            id: "TC-01",
            title: "Cart total is returned",
            type: "api",
            priority: "high",
            source: [{ kind: "quote", text: "Cart total with discount codes" }],
            data: {},
            steps: [
              { id: "S1", action: "GET /cart", expect: { description: "The cart answers", status: 200 } },
            ],
            evidence: ["response"],
          },
        ],
        open_questions: [],
        out_of_scope: [],
      }),
    };
    const forced = await p.run(
      ["plan", "DEMO-1", "--override-readiness", "spike: criteria come with the demo"],
      {
        script: [draft],
      },
    );
    expect(forced.out).toContain("Plan v1:");
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { readiness: { result: string }; readinessOverride: { by: string; reason: string } };
    };
    expect(record.data.readiness.result).toBe("NEEDS_CLARIFICATION");
    expect(record.data.readinessOverride).toMatchObject({
      by: "qa-lead",
      reason: "spike: criteria come with the demo",
    });
    expect(await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8")).toContain(
      '"readiness.overridden"',
    );
  }, 180_000);

  it("REQ-PLAN-13/AC4+AC5: a ready ticket plans at once; its risk comes from the changed paths and the project's rules", async () => {
    const p = await createDemoPipeline({
      config: [
        'readiness: { comment: not_ready, risk_rules: [{ pattern: "^cart\\\\.ts$", level: medium, reason: "the cart" }] }',
      ],
    });
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-1"]);
    const planned = await p.run(["plan", "DEMO-1"], { script: flowScript("DEMO-1") });
    expect(planned.out).toContain("Readiness: READY · risk medium");
    expect(planned.out).toContain("  risk medium: the cart (cart.ts)");
    expect(planned.out).toContain("Plan v1:");
    // comment: not_ready posts nothing for a ready ticket.
    await expect(
      readFile(join(p.runDir, "report", "published", "jira-comment.readiness.wiki.txt"), "utf8"),
    ).rejects.toThrow();
  }, 180_000);
});
