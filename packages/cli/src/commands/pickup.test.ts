import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { createHmac } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";
import { webhookAuthorized, webhookTicket } from "./pickup.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const SECRET = "fictional-webhook-secret";
const FLOW = [
  "workflow:",
  "  statuses: { start: 'Ready for QA', in_testing: 'In QA', waiting_for_approval: 'Plan review', needs_info: 'Needs info', passed: 'QA passed', failed: 'In development', needs_review: 'QA review' }",
  "  approvers_group: qa-leads",
  "  pickup: { secret: secret://env/QJ_WEBHOOK_SECRET }",
];

const setup = async () => {
  // The first run is 20261003-1046-aaaa; once it exists, later runs get other ids.
  let first = "";
  let n = 0;
  const random = () => (first !== "" && existsSync(first) ? ((n++ * 0.37) % 0.98) + 0.01 : 0);
  const p = await createDemoPipeline({
    config: FLOW,
    env: { QJ_WEBHOOK_SECRET: SECRET },
    ports: { random },
  });
  first = p.runDir;
  cleanups.push(p.cleanup);
  const ticketFile = join(p.project, "tickets", "DEMO-1.json");
  const ticket = async () =>
    JSON.parse(await readFile(ticketFile, "utf8")) as { status: string; acceptanceCriteria: string[] };
  const patch = async (fields: Record<string, unknown>) => {
    await writeFile(ticketFile, JSON.stringify({ ...(await ticket()), ...fields }));
  };
  const runs = async () =>
    (
      JSON.parse(
        await readFile(join(p.home, "runs", "DEMO-1", "index.json"), "utf8").catch(() => '{"runs":[]}'),
      ) as {
        runs: { runId: string }[];
      }
    ).runs;
  const [analysis, draft] = flowScript("DEMO-1");
  return { ...p, ticket, patch, runs, plan: [analysis ?? { text: "" }, draft ?? { text: "" }] };
};

const freePort = (): Promise<number> =>
  new Promise((done) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() => {
        done(typeof a === "object" && a ? a.port : 0);
      });
    });
  });

describe("picking tickets up (REQ-FLOW-01)", () => {
  it("REQ-FLOW-01/AC2+AC4: a poll picks up the ticket in the start status, moves it with a comment and posts the plan", async () => {
    const p = await setup();
    const r = await p.run(["workflow", "poll", "--once"], { script: p.plan });
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain('Polled: 1 ticket(s) in "Ready for QA".');
    expect(r.out).toContain('Moved DEMO-1 to "In QA" (run 20261003-1046-aaaa started).');
    expect(r.out).toContain("Posted plan v1 to DEMO-1.");
    expect((await p.ticket()).status).toBe("Plan review");
    expect(
      await readFile(join(p.runDir, "report", "published", "jira-comment.started.wiki.txt"), "utf8"),
    ).toContain("QAJitsu started run 20261003-1046-aaaa for DEMO-1 (poll).");
    expect(await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8")).toContain('"ticket.picked_up"');
    // The ticket left the start status: the next poll finds nothing.
    expect((await p.run(["workflow", "poll", "--once"])).out).toContain("Polled: 0 ticket(s)");
    expect(await p.runs()).toHaveLength(1);
  });

  it("REQ-PLAN-13/AC6: a ticket answered after NEEDS_CLARIFICATION is checked again when it returns to the start status", async () => {
    const p = await setup();
    const criteria = (await p.ticket()).acceptanceCriteria;
    await p.patch({ acceptanceCriteria: [] });
    const quote = [{ kind: "quote", text: "Cart total with discount codes" }];
    const analysis = {
      text: JSON.stringify({
        summary: "Cart total.",
        change_type: ["api"],
        endpoints: [{ method: "GET", path: "/cart", source: quote }],
        confidence: "high",
      }),
    };
    const first = await p.run(["workflow", "poll", "--once"], { script: [analysis] });
    expect(first.out).toContain("Readiness: NEEDS_CLARIFICATION");
    expect((await p.ticket()).status).toBe("Needs info");
    // The author answers and sends the ticket back to QA.
    await p.patch({ acceptanceCriteria: criteria, status: "Ready for QA" });
    const second = await p.run(["workflow", "poll", "--once"], { script: p.plan });
    expect(second.out).toContain("Readiness: READY");
    expect(second.out).toContain("Posted plan v1 to DEMO-1.");
    expect(await p.runs()).toHaveLength(2);
  });

  it("REQ-FLOW-01/AC1+AC3: the webhook starts a ticket with the shared secret or an HMAC signature; anything else is refused and logged", async () => {
    const p = await setup();
    const port = await freePort();
    const signals = new EventEmitter();
    const serving = p.run(["workflow", "serve", "--port", String(port)], {
      script: p.plan,
      signals: signals,
    });
    const url = `http://127.0.0.1:${String(port)}/jira`;
    const post = async (body: string, headers: Record<string, string> = {}, path = "/jira") => {
      for (let i = 0; i < 100; i += 1)
        try {
          return await fetch(url.replace("/jira", path), { method: "POST", body, headers });
        } catch {
          await new Promise((d) => setTimeout(d, 50));
        }
      throw new Error("server did not start");
    };
    const body = JSON.stringify({ issue: { key: "DEMO-1", fields: { status: { name: "Ready for QA" } } } });
    expect((await post(body)).status).toBe(401);
    expect((await post(body, { "x-qajitsu-token": "wrong" })).status).toBe(401);
    expect((await post(body, { "x-hub-signature": "sha256=00" })).status).toBe(401);
    expect((await post(body, { "x-qajitsu-token": SECRET }, "/other")).status).toBe(404);
    expect((await post("not json", { "x-qajitsu-token": SECRET })).status).toBe(400);
    expect((await post(JSON.stringify({ ticket: "SHOP-1" }), { "x-qajitsu-token": SECRET })).status).toBe(
      400,
    );
    expect((await post("x".repeat(70_000), { "x-qajitsu-token": SECRET })).status).toBe(413);
    const signature = `sha256=${createHmac("sha256", SECRET).update(body).digest("hex")}`;
    const accepted = await post(body, { "x-hub-signature": signature });
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toEqual({ ticket: "DEMO-1", queued: true });
    // The same ticket again while it is queued or running: picked up once.
    expect(
      await (await post(JSON.stringify({ ticket: "DEMO-1" }), { "x-qajitsu-token": SECRET })).json(),
    ).toEqual({
      ticket: "DEMO-1",
      queued: false,
    });
    for (let i = 0; i < 200 && (await p.ticket()).status !== "Plan review"; i += 1)
      await new Promise((d) => setTimeout(d, 50));
    signals.emit("SIGINT");
    const r = await serving;
    expect(r.exitCode).toBe(0);
    expect(r.out).toContain(`Listening on ${url}`);
    expect((await p.ticket()).status).toBe("Plan review");
    expect(await p.runs()).toHaveLength(1);
    const log = await readFile(join(p.home, "runs", "pickup.jsonl"), "utf8");
    expect(log.match(/"webhook\.refused"/g)).toHaveLength(7);
    expect(log).toContain('"reason":"unauthenticated"');
    expect(log).not.toContain(SECRET);
    expect(log).not.toContain("Ready for QA");
  });

  it("REQ-FLOW-01/AC1+AC4: a ticket stuck in the start status is not picked up again while its run is open; a reset frees it", async () => {
    const p = await setup();
    // The team's workflow offers no way out of "Ready for QA".
    await writeFile(
      join(p.project, "tickets", "workflow.json"),
      JSON.stringify({ transitions: { "Ready for QA": [] }, groups: { "qa-leads": ["acc-anna"] } }),
    );
    expect((await p.run(["workflow", "poll", "--once"], { script: p.plan })).err).toContain(
      "DEMO-1 stays where it is",
    );
    const again = await p.run(["workflow", "poll", "--once"], { script: p.plan });
    expect(again.out).toContain(
      "DEMO-1 not picked up: run 20261003-1046-aaaa is still open; finish it or close it with qajitsu work reset DEMO-1.",
    );
    expect(await p.runs()).toHaveLength(1);
    expect((await p.run(["work", "reset", "DEMO-1"])).exitCode).toBe(0);
    await p.run(["workflow", "poll", "--once"], { script: p.plan });
    expect(await p.runs()).toHaveLength(2);
  });

  it("REQ-FLOW-01/AC1: a webhook for a ticket that is not in the start status starts nothing; the tracker decides, not the body", async () => {
    const p = await setup();
    await p.patch({ status: "Done" });
    const port = await freePort();
    const signals = new EventEmitter();
    const serving = p.run(["workflow", "serve", "--port", String(port)], { signals: signals });
    let res: Response | undefined;
    for (let i = 0; i < 100 && !res; i += 1)
      res = await fetch(`http://127.0.0.1:${String(port)}/jira`, {
        method: "POST",
        headers: { "x-qajitsu-token": SECRET },
        body: JSON.stringify({ issue: { key: "DEMO-1", fields: { status: { name: "Ready for QA" } } } }),
      }).catch(async () => {
        await new Promise((d) => setTimeout(d, 50));
        return undefined;
      });
    expect(res?.status).toBe(202);
    for (let i = 0; i < 100; i += 1) {
      const log = await readFile(join(p.home, "runs", "pickup.jsonl"), "utf8").catch(() => "");
      if (log.includes("pickup.skipped")) break;
      await new Promise((d) => setTimeout(d, 50));
    }
    signals.emit("SIGINT");
    const r = await serving;
    expect(r.out).toContain('DEMO-1 not picked up: it is in "Done", not "Ready for QA".');
    expect(await p.runs()).toHaveLength(0);
  });

  it("REQ-FLOW-01/AC3: the webhook never runs without a secret", async () => {
    const p = await createDemoPipeline({ config: FLOW.slice(0, 3) });
    cleanups.push(p.cleanup);
    const r = await p.run(["workflow", "serve", "--port", "0"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[WEBHOOK_SECRET_MISSING]");
  });

  it("REQ-FLOW-01/AC3: authentication and the ticket of a webhook body", () => {
    const body = Buffer.from('{"ticket":"DEMO-2"}');
    const hmac = `sha256=${createHmac("sha256", "s3").update(body).digest("hex")}`;
    expect(webhookAuthorized({ "x-qajitsu-token": "s3" }, body, "s3")).toBe(true);
    expect(webhookAuthorized({ "x-hub-signature": hmac }, body, "s3")).toBe(true);
    expect(webhookAuthorized({ "x-hub-signature": hmac }, Buffer.from('{"ticket":"DEMO-3"}'), "s3")).toBe(
      false,
    );
    expect(webhookAuthorized({ "x-qajitsu-token": "s3x" }, body, "s3")).toBe(false);
    expect(webhookAuthorized({}, body, "s3")).toBe(false);
    expect(webhookTicket({ ticket: "DEMO-2" }, "DEMO")).toBe("DEMO-2");
    expect(webhookTicket({ issue: { key: "DEMO-9" } }, "DEMO")).toBe("DEMO-9");
    expect(webhookTicket({ ticket: "SHOP-1" }, "DEMO")).toBeUndefined();
    expect(webhookTicket({ ticket: "DEMO-1; rm -rf /" }, "DEMO")).toBeUndefined();
    expect(webhookTicket(null, "DEMO")).toBeUndefined();
  });
});
