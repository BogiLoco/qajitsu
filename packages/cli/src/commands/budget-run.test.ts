import { appendFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  parseEventLines,
  SPEND_LEDGER_FILE,
  SpendEntrySchema,
  ticketVersion,
  TicketSnapshotSchema,
  type SpendEntry,
} from "@qajitsu/core";
import { runTiming } from "@qajitsu/report";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject, record } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const ledgerOf = (home: string) => join(home, "runs", SPEND_LEDGER_FILE);
const readLedger = async (home: string): Promise<SpendEntry[]> =>
  (await readFile(ledgerOf(home), "utf8"))
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => SpendEntrySchema.parse(JSON.parse(l)));
const versionOf = async (dir: string) =>
  ticketVersion(
    TicketSnapshotSchema.parse(JSON.parse(await readFile(join(dir, "ticket", "ticket.json"), "utf8"))),
  );
/** Spend of earlier work, added to the ledger as code would have written it. */
const seed = async (
  home: string,
  entry: { readonly ticketVersion: string } & Record<string, unknown>,
): Promise<void> => {
  await mkdir(dirname(ledgerOf(home)), { recursive: true });
  const common = {
    ts: new Date().toISOString(),
    project: "demo-shop",
    ticket: "DEMO-1",
    runId: "20261101-090000-aaaa",
    stage: "run",
  };
  const full = SpendEntrySchema.parse(
    entry["kind"] === "runtime"
      ? { ...common, ...entry }
      : {
          ...common,
          kind: "model",
          role: "author",
          model: "mock/scripted",
          caseIds: [],
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0,
          costUsd: null,
          ...entry,
        },
  );
  await appendFile(ledgerOf(home), `${JSON.stringify(full)}\n`);
};
const resultsOf = async (dir: string) => (await record(dir)).data["results"] as Record<string, string>;

describe("ticket and month budgets in qj plan and qj run (REQ-FLOW-06)", () => {
  it("REQ-FLOW-06/AC2+AC3+AC4: every call and every command's active time reach the project ledger, attributed to their case or the ticket", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await rm(join(dir, "specs", "TC-02.spec.ts"));
    await p.run(["run", "DEMO-1", "--build"]);
    const entries = await readLedger(p.home);
    const version = await versionOf(dir);
    const runId = dir.split("/").at(-1);
    expect(
      entries.every((e) => e.ticket === "DEMO-1" && e.ticketVersion === version && e.runId === runId),
    ).toBe(true);
    const calls = entries.filter((e) => e.kind === "model");
    // Analysis and planning are shared work of the ticket; the author's calls belong to the case it wrote.
    expect(calls.filter((e) => e.role === "analyst" || e.role === "planner").map((e) => e.caseIds)).toEqual([
      [],
      [],
    ]);
    const author = calls.filter((e) => e.role === "author");
    expect(author.length).toBeGreaterThan(0);
    expect(author.every((e) => e.caseIds.join() === "TC-02")).toBe(true);
    // The scripted model has no price: its cost is unknown, never 0.
    expect(calls.every((e) => e.costUsd === null)).toBe(true);
    // Active time is added once per command, never counted twice: the ledger's sum is the journal's.
    const journal = parseEventLines(await readFile(join(dir, "journal", "events.jsonl"), "utf8")).events;
    const active = entries.reduce((n, e) => n + (e.kind === "runtime" ? e.activeMs : 0), 0);
    expect(Math.abs(active - runTiming(journal).activeMs)).toBeLessThanOrEqual(entries.length);
  }, 240_000);

  it("REQ-FLOW-06/AC5+AC6: a ticket at its limit writes no further spec; that case is NOT_RUN with the reason, written specs still run", async () => {
    const p = await createBuildProject(`${apiService()}\nbudget: { ticket: { max_tokens: 5000000 } }`);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await rm(join(dir, "specs", "TC-02.spec.ts"));
    await seed(p.home, { ticketVersion: await versionOf(dir), inputTokens: 5_000_000 });
    await p.run(["run", "DEMO-1", "--build"]);
    expect(await resultsOf(dir)).toEqual({ "TC-01": "PASSED", "TC-02": "NOT_RUN" });
    const tc02 = await readFile(join(dir, "results", "TC-02.json"), "utf8");
    expect(tc02).toMatch(
      /ticket budget reached: 5\d{6} of 5000000 tokens spent on this version of the ticket/,
    );
    const events = parseEventLines(await readFile(join(dir, "journal", "events.jsonl"), "utf8")).events;
    expect(events.find((e) => e.event === "budget.exceeded")?.details).toMatchObject({
      scope: "ticket",
      metric: "tokens",
      limit: 5_000_000,
    });
    // REQ-FLOW-06/AC8: the comment's preview carries the budget section, computed from the journal and the results.
    const preview = await p.run(["publish", "DEMO-1"], [{ text: "{}" }], { ask: ["n"] });
    expect(preview.out).toContain("Budget:");
    expect(preview.out).toMatch(/Work stopped: ticket budget reached: 5\d{6} of 5000000 tokens/);
    expect(preview.out).toContain("Not tested because of it: TC-02 NOT_RUN.");
    expect(preview.out).toContain("The other 1 of 2 case(s) have their computed results above.");
    // Nothing was sent for TC-02.
    expect((await readLedger(p.home)).some((e) => e.kind === "model" && e.caseIds.includes("TC-02"))).toBe(
      false,
    );
  }, 240_000);

  it("REQ-FLOW-06/AC4: spend on an earlier version of the ticket does not count against the current one", async () => {
    const p = await createBuildProject(`${apiService()}\nbudget: { ticket: { max_tokens: 5000000 } }`);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await seed(p.home, { ticketVersion: "0".repeat(64), inputTokens: 9_000_000 });
    await p.run(["run", "DEMO-1", "--build"]);
    expect(await resultsOf(dir)).toEqual({ "TC-01": "PASSED", "TC-02": "PASSED" });
  }, 240_000);

  it("REQ-FLOW-06/AC5+AC6: the month's limit is shared by every ticket of the project", async () => {
    const p = await createBuildProject(`${apiService()}\nbudget: { month: { max_tokens: 5000000 } }`);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await rm(join(dir, "specs", "TC-02.spec.ts"));
    await seed(p.home, { ticket: "DEMO-9", ticketVersion: "1".repeat(64), outputTokens: 5_000_000 });
    await p.run(["run", "DEMO-1", "--build"]);
    expect(await resultsOf(dir)).toEqual({ "TC-01": "PASSED", "TC-02": "NOT_RUN" });
    const month = new Date().toISOString().slice(0, 7);
    expect(await readFile(join(dir, "results", "TC-02.json"), "utf8")).toContain(`month budget reached: 5`);
    expect(await readFile(join(dir, "results", "TC-02.json"), "utf8")).toContain(`tokens spent in ${month}`);
  }, 240_000);

  it("REQ-FLOW-06/AC5: a ticket's active minutes are checked before each case; every remaining case is NOT_RUN", async () => {
    const p = await createBuildProject(`${apiService()}\nbudget: { ticket: { max_minutes: 1 } }`);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await seed(p.home, { kind: "runtime", ticketVersion: await versionOf(dir), activeMs: 60_000 });
    await p.run(["run", "DEMO-1", "--build"]);
    const results = await resultsOf(dir);
    expect(Object.values(results)).not.toContain("PASSED");
    expect(Object.values(results)).toContain("NOT_RUN");
    const notRun = Object.entries(results).find(([, s]) => s === "NOT_RUN")?.[0] ?? "";
    expect(await readFile(join(dir, "results", `${notRun}.json`), "utf8")).toMatch(
      /ticket budget reached: 1\.\d of 1\.0 minutes spent on this version of the ticket/,
    );
  }, 240_000);

  it("REQ-FLOW-06/AC6+AC7: a model without a price under a month cost limit blocks planning before anything is sent", async () => {
    const p = await createBuildProject(`${apiService()}\nbudget: { month: { max_cost_usd: 50 } }`);
    cleanups.push(p.cleanup);
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const planned = await p.run(["plan", "DEMO-1"], [{ text: "{}" }]);
    expect(planned.exitCode).toBe(2);
    expect(planned.err).toContain("[UNKNOWN_PRICE_UNDER_BUDGET]");
    expect(planned.err).toContain("declare cost_per_mtok under models.providers.mock.models.scripted");
    expect(planned.model.mock.doGenerateCalls).toHaveLength(0);
    const index = JSON.parse(await readFile(join(p.home, "runs", "DEMO-1", "index.json"), "utf8")) as {
      latest: string;
    };
    const run = await record(join(p.home, "runs", "DEMO-1", index.latest));
    expect(run.data["blocked"]).toMatchObject({
      reason: "UNKNOWN_PRICE_UNDER_BUDGET",
      budget: { scope: "month", metric: "cost", limit: 50 },
    });
  }, 240_000);

  it("REQ-FLOW-06/AC2: a ledger that does not parse refuses new work under a ticket or month budget", async () => {
    const p = await createBuildProject(`${apiService()}\nbudget: { ticket: { max_cost_usd: 50 } }`);
    cleanups.push(p.cleanup);
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    await mkdir(dirname(ledgerOf(p.home)), { recursive: true });
    await writeFile(ledgerOf(p.home), "{ not json\n");
    const planned = await p.run(["plan", "DEMO-1"], [{ text: "{}" }]);
    expect(planned.exitCode).not.toBe(0);
    expect(planned.err).toContain("[LEDGER_INVALID]");
    expect(planned.err).toContain("qajitsu budget --rebuild");
    expect(planned.model.mock.doGenerateCalls).toHaveLength(0);
  }, 240_000);

  it("REQ-FLOW-06/AC5: a month at its limit starts no run; a ticket at its limit stops its new run BLOCKED before any model", async () => {
    const p = await createBuildProject(
      `${apiService()}\nbudget: { ticket: { max_tokens: 1000 }, month: { max_tokens: 1000000 } }`,
    );
    cleanups.push(p.cleanup);
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const indexFile = join(p.home, "runs", "DEMO-1", "index.json");
    const first = (JSON.parse(await readFile(indexFile, "utf8")) as { latest: string }).latest;
    const version = await versionOf(join(p.home, "runs", "DEMO-1", first));
    await seed(p.home, { ticketVersion: version, inputTokens: 1000 });
    const ticketStopped = await p.run(["fetch", "DEMO-1"]);
    expect(ticketStopped.exitCode).toBe(2);
    expect(ticketStopped.err).toContain(
      "[TICKET_BUDGET_EXCEEDED]: ticket budget reached: 1000 of 1000 tokens spent on this version of the ticket",
    );
    const second = (JSON.parse(await readFile(indexFile, "utf8")) as { latest: string }).latest;
    expect(second).not.toBe(first);
    const blocked = await record(join(p.home, "runs", "DEMO-1", second));
    expect(blocked.data["blocked"]).toMatchObject({
      reason: "TICKET_BUDGET_EXCEEDED",
      budget: { scope: "ticket" },
    });
    // The month is shared: another ticket's spend stops every new run before it exists.
    await seed(p.home, { ticket: "DEMO-9", ticketVersion: "2".repeat(64), outputTokens: 1_000_000 });
    const monthStopped = await p.run(["fetch", "DEMO-1"]);
    expect(monthStopped.exitCode).toBe(2);
    expect(monthStopped.err).toContain("[MONTH_BUDGET_EXCEEDED]: month budget reached");
    expect((JSON.parse(await readFile(indexFile, "utf8")) as { latest: string }).latest).toBe(second);
  }, 240_000);
});
