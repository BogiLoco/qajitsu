// Adversarial suite: spend is hidden from the ticket and month budgets (REQ-FLOW-06).
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGuard, createJournal, DEFAULT_PROTECTED_PATHS } from "@qajitsu/guard";
import { SPEND_LEDGER_FILE } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { apiService, createBuildProject } from "../support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const BUDGETED = `${apiService()}\nbudget: { ticket: { max_tokens: 900000000 }, month: { max_tokens: 900000000 } }`;
const monthTokens = async (p: Awaited<ReturnType<typeof createBuildProject>>): Promise<number> => {
  const r = await p.run(["budget", "--json"]);
  return (JSON.parse(r.out.slice(r.out.indexOf("{"))) as { month: { tokens: number } }).month.tokens;
};

describe("budgets cannot be laundered (REQ-FLOW-06/AC2)", () => {
  it("REQ-FLOW-06/AC2: a deleted or edited ledger refuses new runs until it is rebuilt from the journals, with the same totals", async () => {
    const p = await createBuildProject(BUDGETED);
    cleanups.push(p.cleanup);
    await p.prepare();
    const ledger = join(p.home, "runs", SPEND_LEDGER_FILE);
    const before = await monthTokens(p);
    expect(before).toBeGreaterThan(0);

    // Deleting the ledger would reset every budget: the journals still prove the spend.
    await rm(ledger);
    const refused = await p.run(["fetch", "DEMO-1"]);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.err).toContain("[LEDGER_MISMATCH]");
    expect(refused.err).toContain("qajitsu budget --rebuild");
    expect((await p.run(["budget"])).exitCode).toBe(2);

    const rebuilt = await p.run(["budget", "--rebuild"]);
    expect(rebuilt.exitCode).toBe(0);
    expect(await monthTokens(p)).toBe(before);
    expect((await p.run(["budget"])).exitCode).toBe(0);

    // Lowering a call's tokens or cost in place is found the same way.
    const lines = (await readFile(ledger, "utf8")).trim().split("\n");
    const edited = lines.map((l, i) => {
      if (i > 0) return l;
      const e = JSON.parse(l) as Record<string, unknown>;
      return JSON.stringify({ ...e, inputTokens: 0, outputTokens: 0 });
    });
    await writeFile(ledger, `${edited.join("\n")}\n`);
    expect((await p.run(["fetch", "DEMO-1"])).err).toContain("[LEDGER_MISMATCH]");
    expect((await p.run(["budget", "--rebuild"])).exitCode).toBe(0);
    expect(await monthTokens(p)).toBe(before);
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
  }, 240_000);

  it("REQ-FLOW-06/AC2: a removed run keeps its spend in the month, also through a rebuild", async () => {
    const p = await createBuildProject(BUDGETED);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const before = await monthTokens(p);
    await rm(dir, { recursive: true, force: true });
    expect(await monthTokens(p)).toBe(before);
    expect((await p.run(["budget", "--rebuild"])).exitCode).toBe(0);
    expect(await monthTokens(p)).toBe(before);
  }, 240_000);

  it("REQ-FLOW-06/AC2 + INV-2: an agent cannot reach the ledger; it lies outside every run workspace", () => {
    const run = "/runs/DEMO-1/20261118-100000-abcd";
    const guard = createGuard({
      run: "20261118-100000-abcd",
      stage: "author",
      policy: {
        workspaceRoot: run,
        allowedTools: new Set(["write_file"]),
        writeTools: new Set(["write_file"]),
        protectedPaths: DEFAULT_PROTECTED_PATHS,
        networkTools: new Set(),
        allowedOrigins: [],
      },
      journal: createJournal(
        () => undefined,
        () => new Date("2026-11-18T10:00:00Z"),
        (v) => v,
      ),
    });
    // The ticket snapshot decides the ticket's content version (AC4): rewriting it would open a fresh budget window.
    for (const path of [
      `../../${SPEND_LEDGER_FILE}`,
      `/runs/${SPEND_LEDGER_FILE}`,
      "../../budget/journals.json",
      "ticket/ticket.json",
      "Ticket/ticket.md",
    ]) {
      const decision = guard.check({ tool: "write_file", input: { path, content: "" } });
      expect(decision.allowed, path).toBe(false);
    }
  });

  it("REQ-FLOW-06/AC2: a broken journal cache or run record never stops new runs; a rebuild starts the cache over", async () => {
    const p = await createBuildProject(BUDGETED);
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    const cache = join(p.home, "runs", "budget", "journals.json");
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    await writeFile(cache, "{ half a fi");
    await writeFile(join(dir, "run.json"), "not json");
    const fetched = await p.run(["fetch", "DEMO-1"]);
    expect(fetched.err).toBe("");
    expect(fetched.exitCode).toBe(0);
    expect((await p.run(["budget", "--rebuild"])).exitCode).toBe(0);
    await expect(readFile(cache, "utf8")).rejects.toThrow();
  }, 240_000);

  it("REQ-FLOW-06/AC2: moving calls to another month or ticket version, or cutting active time, is found or undone", async () => {
    const p = await createBuildProject(BUDGETED);
    cleanups.push(p.cleanup);
    await p.prepare();
    const ledger = join(p.home, "runs", SPEND_LEDGER_FILE);
    const original = await readFile(ledger, "utf8");
    const edit = async (change: (e: Record<string, unknown>) => Record<string, unknown> | undefined) => {
      const lines = original
        .trim()
        .split("\n")
        .flatMap((l) => {
          const e = change(JSON.parse(l) as Record<string, unknown>);
          return e === undefined ? [] : [JSON.stringify(e)];
        });
      await writeFile(ledger, `${lines.join("\n")}\n`);
    };
    // Calls dated last month would leave this month's budget.
    await edit((e) => (e["kind"] === "model" ? { ...e, ts: "2020-01-15T10:00:00.000Z" } : e));
    expect((await p.run(["fetch", "DEMO-1"])).err).toContain("[LEDGER_MISMATCH]");
    // Calls booked to another version of the ticket would open a fresh ticket budget.
    await edit((e) => ({ ...e, ticketVersion: "e".repeat(64) }));
    const moved = await p.run(["fetch", "DEMO-1"]);
    expect(moved.err).toContain("[LEDGER_MISMATCH]");
    expect(moved.err).toContain("booked to another ticket or ticket version");
    // Active time cut from the ledger comes back from the journal.
    await edit((e) => (e["kind"] === "runtime" ? undefined : e));
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const restored = (await readFile(ledger, "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(restored.some((e) => e["kind"] === "runtime" && Number(e["activeMs"]) > 0)).toBe(true);
  }, 240_000);

  it("REQ-FLOW-06/AC2: a ledger deleted after the run was fetched stops its plan before any model call", async () => {
    const p = await createBuildProject(BUDGETED);
    cleanups.push(p.cleanup);
    await p.prepare();
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    await rm(join(p.home, "runs", SPEND_LEDGER_FILE));
    const planned = await p.run(["plan", "DEMO-1"], [{ text: "{}" }]);
    expect(planned.exitCode).not.toBe(0);
    expect(planned.err).toContain("[LEDGER_MISMATCH]");
    expect(planned.model.mock.doGenerateCalls).toHaveLength(0);
  }, 240_000);
});
