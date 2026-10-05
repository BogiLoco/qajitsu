// A noisy application cannot change a verdict (REQ-EVD-07/AC4, invariant 1): console errors, failing background
// requests and accessibility violations are listed as observations, while the statuses and counts stay those the
// runner's assertions give.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const NOISE = JSON.stringify({
  console: [{ level: "pageerror", text: "TypeError: x is undefined", url: "/app/checkout" }],
  http: [{ method: "POST", url: "/api/telemetry", status: 503 }],
  accessibility: [
    {
      rule: "color-contrast",
      impact: "serious",
      help: "Contrast",
      url: "/app/checkout",
      targets: ["button"],
    },
  ],
});

describe("passive observations never change a verdict (REQ-EVD-07/AC4)", () => {
  it("REQ-EVD-07/AC4 + invariant 1: a PASSED web case with a page full of errors stays PASSED; the noise is listed separately", async () => {
    const p = await createDemoPipeline({
      ticket: "DEMO-4",
      wrapExecutor: (inner) => async (input) => {
        const record = await inner(input);
        return {
          ...record,
          evidence: [
            ...record.evidence,
            { stepId: "case", kind: "log", name: "observations.json", content: NOISE },
          ],
        };
      },
    });
    cleanups.push(p.cleanup);
    const result = await p.executed();
    expect(result.exitCode).toBe(0);
    expect(result.out).toContain("PASSED");
    expect(result.out).not.toMatch(/FAILED|NEEDS_REVIEW|BLOCKED/);
    const html = await readFile(join(p.runDir, "report", "report.html"), "utf8");
    expect(html).toContain("Observations (6, not test results)");
    expect(html).toContain("POST /api/telemetry → 503");
    const preview = await p.run(["publish", "DEMO-4"], { ask: ["n"] });
    expect(preview.out).toMatch(/QAJitsu test results: \d+ cases?: \d+ PASSED\n/);
    expect(preview.out).toContain("Observations (found by code, not test results):");
  }, 120_000);
});
