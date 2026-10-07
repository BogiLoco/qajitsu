import { describe, expect, it } from "vitest";
import { renderBugReport, type BugReportModel } from "./bug-report.js";

const model: BugReportModel = {
  ticket: "DEMO-1",
  runId: "20261006-1000-abcd",
  caseId: "TC-01",
  title: "Cart total is rounded once",
  failures: [{ stepId: "S1", field: "fields.total", expected: 1.01, actual: 1.02 }],
  preconditions: ["Cart has 3 lines of 0.335 PLN"],
  data: { user: "user:standard" },
  steps: [
    { id: "S1", action: "GET /cart", outcome: "failed", detail: "fields.total" },
    { id: "S2", action: "Apply code", outcome: "not run" },
  ],
  environment: { name: "local", baseUrl: "http://localhost:3000", deployedSha: "abc1234" },
  repos: { shop: "7dd075587a97" },
  client: "chromium",
  evidence: [{ path: "TC-01/attempt-1/S1-response.json", kind: "response", sha256: "a".repeat(64) }],
  hint: "product-bug: lines are rounded before summing",
  reproduce: "qajitsu evidence DEMO-1 --run 20261006-1000-abcd --failed",
};

describe("bug report (REQ-PUB-07)", () => {
  it("REQ-PUB-07/AC2+AC3: steps from the plan and runner, expected from the plan, version, client and evidence by hash", () => {
    const r = renderBugReport(model);
    expect(r.summary).toBe("Cart total is rounded once: S1 fields.total expected 1.01 but was 1.02");
    expect(r.text).toContain(
      "Steps to reproduce (approved test plan, with what the runner recorded):\n  1. S1: GET /cart (failed: fields.total)\n  2. S2: Apply code (not run)",
    );
    expect(r.text).toContain("S1 fields.total: expected 1.01, actual 1.02");
    expect(r.text).toContain("Environment: local (http://localhost:3000), deployed abc1234");
    expect(r.text).toContain("Repository shop at 7dd075587a97");
    expect(r.text).toContain("Client: chromium");
    expect(r.text).toContain("TC-01/attempt-1/S1-response.json (response) sha256 aaaaaaaaaaaaaaaa…");
    expect(r.text).toContain("Suggested cause (a hint, not verified):\n  - product-bug");
    expect(r.text).toContain("QAJitsu run 20261006-1000-abcd while testing DEMO-1");
    expect(r.wiki).toContain("h4. Steps to reproduce");
    expect(r.wiki).toContain("# S1: GET /cart (failed: fields.total)");
    expect(JSON.stringify(r.adf)).toContain('"type":"orderedList"');
  });

  it("REQ-PUB-07/AC2: a failure without assertions uses the runner's error; long summaries are cut", () => {
    const r = renderBugReport({
      ...model,
      failures: [],
      error: "HTTP 500 on POST /orders",
      title: "x".repeat(300),
    });
    expect(r.summary.length).toBe(240);
    expect(renderBugReport({ ...model, failures: [], error: "HTTP 500" }).summary).toBe(
      "Cart total is rounded once: HTTP 500",
    );
    expect(renderBugReport({ ...model, failures: [], error: undefined, hint: undefined }).text).not.toContain(
      "Suggested cause",
    );
  });
});
