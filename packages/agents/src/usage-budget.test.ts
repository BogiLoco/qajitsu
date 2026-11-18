import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createEventLog,
  fileSpendLedger,
  parseProjectConfig,
  type RunEvent,
  type SpendEntry,
} from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { TokenBudgetExceededError } from "./errors.js";
import { createUsageTracker, recordCall } from "./usage.js";

// $2 / $10 per million tokens: 100k in + 10k out = $0.30 a call.
const priced = {
  tools: true,
  structuredOutput: true,
  vision: true,
  contextWindow: 200_000,
  costPerMTok: { input: 2, output: 10 },
};
const local = { ...priced, costPerMTok: { input: 0, output: 0 } };
const unpriced = { tools: true, structuredOutput: true, vision: true, contextWindow: 200_000 };
const CALL = { inputTokens: 100_000, outputTokens: 10_000 };
const V = "c".repeat(64);
const NOW = new Date("2026-11-18T10:00:00Z");

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const setup = async (budget: unknown, runId = "run-1") => {
  const dir = await mkdtemp(join(tmpdir(), "qj-usage-"));
  dirs.push(dir);
  const ledger = fileSpendLedger(join(dir, "budget", "spend.jsonl"));
  const events: RunEvent[] = [];
  const log = createEventLog({
    ticket: "SHOP-1",
    run: runId,
    write: (line) => events.push(JSON.parse(line) as RunEvent),
    now: () => NOW,
    mask: (v) => v,
  });
  const config = parseProjectConfig({
    project: "shop",
    jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
    environments: { allowlist: ["http://localhost:3000"] },
    budget,
  });
  const tracker = (run = runId) =>
    createUsageTracker({
      events: log,
      now: () => NOW,
      spend: {
        ledger,
        project: "shop",
        ticket: "SHOP-1",
        ticketVersion: V,
        runId: run,
        budget: config.budget,
      },
    });
  return { ledger, events, tracker };
};
const codeOf = (fn: () => unknown): string | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e instanceof TokenBudgetExceededError ? e.code : `other: ${String(e)}`;
  }
};

describe("ticket and month budgets in the usage tracker (REQ-FLOW-06)", () => {
  it("REQ-FLOW-06/AC2+AC3: every call goes to the ledger with its role, model, cost and the cases it worked for", async () => {
    const { ledger, tracker } = await setup(undefined);
    const usage = tracker();
    await usage.beforeCall("run", "author", "claude/sonnet", priced);
    usage.record("run", "author", "claude/sonnet", priced, CALL, undefined, { caseIds: ["TC-01"] });
    usage.record("run", "auditor", "claude/haiku", priced, CALL, undefined, {
      caseIds: ["TC-01", "TC-02"],
      apportioned: true,
    });
    usage.record("plan", "planner", "claude/sonnet", priced, { ...CALL, cachedInputTokens: 40_000 });
    await usage.recordActiveTime("run", 90_000);
    // A second save of the same run adds only the time since the first one.
    await usage.recordActiveTime("audit", 100_000);
    await usage.recordActiveTime("audit", 100_000);
    const entries = await ledger.read();
    expect(
      entries.map((e) =>
        e.kind === "model" ? [e.role, e.caseIds, e.apportioned ?? false, e.costUsd] : [e.kind, e.activeMs],
      ),
    ).toEqual([
      ["author", ["TC-01"], false, 0.3],
      ["auditor", ["TC-01", "TC-02"], true, 0.3],
      ["planner", [], false, 0.3],
      ["runtime", 90_000],
      ["runtime", 10_000],
    ]);
    const plan = entries[2] as Extract<SpendEntry, { kind: "model" }>;
    expect([plan.inputTokens, plan.cachedInputTokens]).toEqual([60_000, 40_000]);
  });

  it("REQ-FLOW-06/AC5: the call that reaches the ticket budget stops the stage, naming the scope and the numbers", async () => {
    const { events, tracker } = await setup({ ticket: { max_cost_usd: 0.5 } });
    const usage = tracker();
    await usage.beforeCall("run", "author", "claude/sonnet", priced);
    expect(
      codeOf(() => {
        usage.record("run", "author", "claude/sonnet", priced, CALL);
      }),
    ).toBeUndefined();
    expect(
      codeOf(() => {
        usage.record("run", "author", "claude/sonnet", priced, CALL);
      }),
    ).toBe("TICKET_BUDGET_EXCEEDED");
    expect(usage.stopped).toMatchObject({ scope: "ticket", metric: "cost", limit: 0.5, spent: 0.6 });
    expect(events.find((e) => e.event === "budget.exceeded")?.details).toMatchObject({
      scope: "ticket",
      limit: 0.5,
    });
    // Before the next call, nothing more is sent.
    await expect(usage.beforeCall("run", "author", "claude/sonnet", priced)).rejects.toMatchObject({
      code: "TICKET_BUDGET_EXCEEDED",
    });
  });

  it("REQ-FLOW-06/AC5: parallel runs share the ledger: a call is refused once another run used up the month", async () => {
    const { tracker } = await setup({ month: { max_cost_usd: 0.6 } });
    const first = tracker("run-1");
    const second = tracker("run-2");
    await first.beforeCall("run", "author", "claude/sonnet", priced);
    first.record("run", "author", "claude/sonnet", priced, CALL);
    await first.flush();
    // The second run sees the first one's spend: its call that reaches the month's limit stops its stage.
    await second.beforeCall("run", "author", "claude/sonnet", priced);
    expect(
      codeOf(() => {
        second.record("run", "author", "claude/sonnet", priced, CALL);
      }),
    ).toBe("MONTH_BUDGET_EXCEEDED");
    await second.flush();
    await expect(first.beforeCall("run", "author", "claude/sonnet", priced)).rejects.toMatchObject({
      code: "MONTH_BUDGET_EXCEEDED",
      context: { scope: "month", period: "2026-11" },
    });
  });

  it("REQ-FLOW-06/AC7: a paid model without a price is refused under a cost limit before the call; a local one is free", async () => {
    const { ledger, tracker } = await setup({ month: { max_cost_usd: 100 } });
    const usage = tracker();
    await expect(usage.beforeCall("run", "author", "gw/inhouse", unpriced)).rejects.toMatchObject({
      code: "UNKNOWN_PRICE_UNDER_BUDGET",
    });
    await usage.beforeCall("run", "summary", "ollama/qwen3:4b", local);
    usage.record("run", "summary", "ollama/qwen3:4b", local, CALL);
    await usage.flush();
    expect((await ledger.read()).map((e) => (e.kind === "model" ? e.costUsd : undefined))).toEqual([0]);
    // Without a cost limit the unpriced model runs, and its cost is recorded as unknown, not as 0.
    const free = await setup({ month: { max_tokens: 10_000_000 } });
    const u = free.tracker();
    await u.beforeCall("run", "author", "gw/inhouse", unpriced);
    u.record("run", "author", "gw/inhouse", unpriced, CALL);
    await u.flush();
    expect((await free.ledger.read()).map((e) => (e.kind === "model" ? e.costUsd : undefined))).toEqual([
      null,
    ]);
  });

  it("REQ-LLM-09/AC4: without a ledger the run's own cost budget behaves as before", () => {
    const events = createEventLog({
      ticket: "SHOP-1",
      run: "r",
      write: () => undefined,
      now: () => NOW,
      mask: (v) => v,
    });
    const usage = createUsageTracker({ events, costBudgetUsd: 0.5, now: () => NOW });
    expect(
      codeOf(() => {
        usage.record("run", "author", "m", priced, CALL);
      }),
    ).toBeUndefined();
    expect(
      codeOf(() => {
        usage.record("run", "author", "m", priced, CALL);
      }),
    ).toBe("COST_BUDGET_EXCEEDED");
  });

  it("REQ-FLOW-06/AC2: a call that stops a budget is still in the ledger when it returns; a ledger that cannot be written fails the call", async () => {
    const { ledger, tracker } = await setup({ ticket: { max_cost_usd: 0.3 } });
    const usage = tracker();
    await usage.beforeCall("run", "author", "claude/sonnet", priced);
    const stopped = await recordCall(usage, "run", "author", "claude/sonnet", priced, CALL).catch(
      (e: unknown) => e,
    );
    expect((stopped as TokenBudgetExceededError).code).toBe("TICKET_BUDGET_EXCEEDED");
    // Written already, without another flush.
    expect(await ledger.read()).toHaveLength(1);

    const broken = createUsageTracker({
      events: createEventLog({
        ticket: "SHOP-1",
        run: "r",
        write: () => undefined,
        now: () => NOW,
        mask: (v) => v,
      }),
      now: () => NOW,
      spend: {
        ledger: {
          append: () => Promise.reject(new Error("disk full")),
          read: () => Promise.resolve([]),
          rebuild: () => Promise.resolve({ dropped: 0 }),
          topUpActiveTime: () => Promise.resolve(0),
        },
        project: "shop",
        ticket: "SHOP-1",
        ticketVersion: V,
        runId: "r",
        budget: parseProjectConfig({
          project: "shop",
          jira: { type: "file", tickets_dir: "t", project_key: "SHOP" },
          environments: { allowlist: ["http://localhost:3000"] },
        }).budget,
      },
    });
    await expect(recordCall(broken, "run", "author", "claude/sonnet", priced, CALL)).rejects.toThrow(
      "disk full",
    );
    // The failure stays: the next flush reports it too, nothing is lost silently.
    await expect(broken.flush()).rejects.toThrow("disk full");
  });
});
