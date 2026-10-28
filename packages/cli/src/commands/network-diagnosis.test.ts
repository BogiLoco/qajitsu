import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CaseResultFileSchema } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("analysis of the recorded traffic in a run (REQ-EVD-09)", () => {
  it("REQ-EVD-09/AC1+AC2+AC7: a failed web step shows its failed requests; reached endpoints are listed; no status changes", async () => {
    // BUG-07: the API answers 500 while the page shows success. The plan here expects the error message, so the
    // web step fails and its traffic explains why.
    const p = await createDemoPipeline({
      ticket: "DEMO-5",
      flag: "BUG_SILENT_500_TOAST",
      transformPlan: (draft) => draft.replace('"Order placed"', '"Order could not be placed"'),
      beforeRun: async (runDir) => {
        // The change touches the checkout endpoint and one no case reaches.
        const path = join(runDir, "analysis.json");
        const analysis = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
        await writeFile(
          path,
          JSON.stringify({
            ...analysis,
            endpoints: [
              { method: "POST", path: "/checkout", source: [{ kind: "ac", id: "AC1" }] },
              { method: "DELETE", path: "/orders/{id}", source: [{ kind: "ac", id: "AC1" }] },
            ],
          }),
        );
      },
    });
    cleanups.push(p.cleanup);
    const run = await p.executed();
    expect(run.exitCode).toBe(1);
    const result = CaseResultFileSchema.parse(
      JSON.parse(await readFile(join(p.runDir, "results", "TC-01.json"), "utf8")) as unknown,
    );
    const attempt = result.attempts.at(-1);
    const s2 = attempt?.steps.find((s) => s.id === "S2");
    expect(s2?.network).toContainEqual({
      kind: "server-error",
      method: "POST",
      url: "/checkout",
      status: 500,
    });
    expect(attempt?.requests).toContainEqual({ method: "POST", path: "/checkout", status: 500 });
    const html = await readFile(join(p.runDir, "report", "report.html"), "utf8");
    expect(html).toContain("Requests that went wrong in the failed steps");
    expect(html).toContain("S2: POST /checkout · server-error 500");
    expect(html).toContain("<h2>Endpoints of the change</h2>");
    expect(html).toMatch(/<code>POST \/checkout<\/code><\/td><td>TC-01<\/td>/);
    expect(html).toMatch(/<code>DELETE \/orders\/\{id\}<\/code><\/td><td>no case reached it<\/td>/);
    // AC7: the traffic explains, it never decides: the case is FAILED by its assertions alone.
    const status = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { results: Record<string, string> };
    };
    expect(status.data.results).toEqual({ "TC-01": "FAILED" });
  }, 240_000);
});
