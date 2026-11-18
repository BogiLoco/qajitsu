import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetError } from "../errors.js";
import { sumSpend, type SpendEntry } from "./budget.js";
import { fileSpendLedger } from "./ledger.js";

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});
const ledgerFile = async () => {
  const d = await mkdtemp(join(tmpdir(), "qj-ledger-"));
  dirs.push(d);
  return join(d, "budget", "spend.jsonl");
};
const entry = (i: number): Extract<SpendEntry, { kind: "model" }> => ({
  kind: "model",
  ts: "2026-11-10T10:00:00.000Z",
  project: "shop",
  ticket: "SHOP-1",
  ticketVersion: "a".repeat(64),
  runId: `run-${String(i)}`,
  stage: "run",
  role: "author",
  model: "claude/claude-sonnet-5",
  caseIds: [`TC-${String(i)}`],
  inputTokens: 10,
  cachedInputTokens: 0,
  outputTokens: 5,
  costUsd: 0.01,
});

describe("the spend ledger (REQ-FLOW-06/AC2+AC5)", () => {
  it("REQ-FLOW-06/AC2: entries round-trip; a line that is not a valid entry refuses the read", async () => {
    const file = await ledgerFile();
    const ledger = fileSpendLedger(file);
    expect(await ledger.read()).toEqual([]);
    await ledger.append(entry(1), entry(2));
    expect(await ledger.read()).toEqual([entry(1), entry(2)]);
    // A hand-edited or truncated line is never skipped: the ledger cannot be trusted until it is rebuilt.
    for (const bad of [
      "{not json",
      JSON.stringify({ ...entry(3), costUsd: -1 }),
      JSON.stringify({ ...entry(3), admin: true }),
    ]) {
      await writeFile(file, `${JSON.stringify(entry(1))}\n${bad}\n`);
      const error = await ledger.read().catch((e: unknown) => e);
      expect(error, bad).toBeInstanceOf(BudgetError);
      expect((error as BudgetError).code).toBe("LEDGER_INVALID");
      expect((error as BudgetError).message).toContain("Line 2");
    }
    // An invalid entry is never written.
    await expect(ledger.append({ ...entry(4), inputTokens: -5 })).rejects.toThrow();
  });

  it("REQ-FLOW-06/AC5: parallel writers lose no entry, and the totals are their sum", async () => {
    const file = await ledgerFile();
    const writers = Array.from({ length: 20 }, (_, i) => fileSpendLedger(file).append(entry(i)));
    await Promise.all(writers);
    const all = await fileSpendLedger(file).read();
    expect(all).toHaveLength(20);
    expect(new Set(all.map((e) => e.runId)).size).toBe(20);
    expect(sumSpend(all, { ticket: "SHOP-1" }).costUsd).toBeCloseTo(0.2, 9);
    expect((await readFile(file, "utf8")).split("\n").filter(Boolean)).toHaveLength(20);
  });
});
