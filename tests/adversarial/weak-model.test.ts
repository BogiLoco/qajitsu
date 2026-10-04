// REQ-LLM-05/AC2: a weak model makes runs less useful (more BLOCKED), never wrong: with a seeded bug on,
// no author output can turn the case that targets it into PASSED. Statuses come from the trusted
// parent's own recordings and the approved plan (invariants 1 and 4).
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readRunIndex, type TicketKey } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../support/cli-build.js";
import type { Turn } from "../support/mock-model.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const fixture = (id: string) =>
  readFile(new URL(`../../fixtures/specs/demo-1/${id}.spec.ts`, import.meta.url), "utf8");
const code = (text: string): Turn => ({ text: "```ts\n" + text + "```" });

/** fetch, plan, approve without specs, then run with the bug on and the given author turns. */
const runWithAuthor = async (author: Turn[]) => {
  const p = await createBuildProject();
  cleanups.push(p.cleanup);
  const analysis = JSON.stringify({
    summary: "Cart API.",
    change_type: ["api"],
    endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
    confidence: "high",
  });
  const draft = await readFile(new URL("../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8");
  await p.run(["fetch", "DEMO-1"]);
  await p.run(["plan", "DEMO-1"], [{ text: analysis }, { text: draft }]);
  await p.run(["approve", "DEMO-1"]);
  const result = await p.run(["run", "DEMO-1", "--build", "--set", "api.BUG_CART_TOTAL_ROUNDING=1"], author);
  const runId = (await readRunIndex(join(p.home, "runs"), "DEMO-1" as TicketKey)).latest ?? "";
  const record = JSON.parse(await readFile(join(p.home, "runs", "DEMO-1", runId, "run.json"), "utf8")) as {
    data: { results: Record<string, string> };
  };
  return { result, statuses: record.data.results };
};

describe("weak models (REQ-LLM-05/AC2)", () => {
  it("REQ-LLM-05/AC2: an author that cannot write specs makes cases BLOCKED", async () => {
    const { result, statuses } = await runWithAuthor([{ text: "Sorry, I cannot write TypeScript." }]);
    expect(statuses).toEqual({ "TC-01": "BLOCKED", "TC-02": "BLOCKED" });
    expect(result.exitCode).toBe(2);
  }, 180_000);

  it("REQ-LLM-05/AC2: an author that hard-codes the expected value as actual still gets FAILED for the bug", async () => {
    const lying = (await fixture("TC-01")).replace('res.json("total")', "1.01");
    const { statuses } = await runWithAuthor([code(lying), code(await fixture("TC-02"))]);
    expect(statuses["TC-01"]).toBe("FAILED");
  }, 180_000);

  it("REQ-LLM-05/AC2: an author that leaves out the check of the buggy field never gets PASSED", async () => {
    const lazy = (await fixture("TC-01")).replace(/\s*verify\("S1", "fields\.total"[^\n]*\n/, "\n");
    const { statuses } = await runWithAuthor([
      code(lazy),
      code(lazy),
      code(lazy),
      code(await fixture("TC-02")),
    ]);
    expect(statuses["TC-01"]).not.toBe("PASSED");
    expect(["BLOCKED", "NEEDS_REVIEW", "FAILED"]).toContain(statuses["TC-01"]);
  }, 180_000);
});
