import { describe, expect, it } from "vitest";
import {
  renderRegressionComment,
  renderRegressionHtml,
  renderRegressionJUnit,
  renderRegressionMarkdown,
  summarizeRegression,
  type RegressionModel,
} from "./regression.js";

const model = (over: Partial<RegressionModel> = {}): RegressionModel => ({
  date: "2026-10-07 10:00",
  source: "tests@3f2a9c1e0b11",
  environment: "staging",
  cases: [
    {
      ticket: "SHOP-1",
      caseId: "TC-01",
      title: "Total <rounded>",
      type: "api",
      status: "PASSED",
      runId: "r1",
    },
    {
      ticket: "SHOP-1",
      caseId: "TC-02",
      title: "Codes",
      type: "web",
      status: "FAILED",
      runId: "r1",
      reason: "S1 total",
    },
    {
      ticket: "SHOP-2",
      caseId: "TC-01",
      title: "Login",
      type: "web",
      status: "BLOCKED",
      runId: "r2",
      reason: "spec changed",
    },
    { ticket: "SHOP-2", caseId: "TC-02", title: "Logout", type: "web", status: "NOT_RUN", runId: "r2" },
  ],
  problems: [{ path: "tests/qajitsu/X-1", problem: "not a valid pack" }],
  ...over,
});

describe("regression report (REQ-EXEC-17/AC3)", () => {
  it("REQ-EXEC-17/AC3: counts come from the computed statuses; a FAILED case is a regression", () => {
    const s = summarizeRegression(model());
    expect(s.packs).toBe(2);
    expect(s.counts).toEqual({ PASSED: 1, FAILED: 1, BLOCKED: 1, NOT_RUN: 1 });
    expect(s.regressions.map((c) => `${c.ticket} ${c.caseId}`)).toEqual(["SHOP-1 TC-02"]);
    expect(s.notVerified).toHaveLength(2);
  });

  it("REQ-EXEC-17/AC3: markdown leads with the regressions; a clean suite says so, an empty one does not", () => {
    const md = renderRegressionMarkdown(model());
    expect(md).toContain(
      "**1 REGRESSION(S): 4 case(s) in 2 pack(s): 1 PASSED, 1 FAILED, 1 BLOCKED, 1 NOT_RUN; 1 pack(s) could not run.**",
    );
    expect(md).toContain("- SHOP-1 TC-02 FAILED: Codes (S1 total)");
    expect(md).toContain("- SHOP-2 TC-01 BLOCKED: Login (spec changed)");
    expect(md).toContain("- tests/qajitsu/X-1: not a valid pack");
    const clean = model({ cases: [model().cases[0]!], problems: [] });
    expect(renderRegressionMarkdown(clean)).toContain(
      "**NO REGRESSIONS: 1 case(s) in 1 pack(s): 1 PASSED.**",
    );
    expect(renderRegressionMarkdown(model({ cases: [], problems: [] }))).toContain("NOT VERIFIED: 0 case(s)");
    expect(renderRegressionMarkdown(model({ cases: [model().cases[2]!], problems: [] }))).toContain(
      "**NOT VERIFIED:",
    );
  });

  it("REQ-EXEC-17/AC3: HTML escapes every text; JUnit has one suite per pack with failures, errors and skips", () => {
    const html = renderRegressionHtml(model());
    expect(html).toContain("Total &lt;rounded&gt;");
    expect(html).not.toContain("<script");
    const junit = renderRegressionJUnit(model());
    expect(junit).toContain(
      '<testsuite name="regression SHOP-1" tests="2" failures="1" errors="0" skipped="0">',
    );
    expect(junit).toContain(
      '<testsuite name="regression SHOP-2" tests="2" failures="0" errors="1" skipped="1">',
    );
    expect(junit).toContain('name="TC-01 Total &lt;rounded&gt;"/>');
    expect(junit).toContain('<failure message="FAILED: S1 total"/>');
    expect(junit).toContain('<error message="BLOCKED: spec changed"/>');
    expect(junit).toContain('<skipped message="NOT_RUN"/>');
  });

  it("REQ-EXEC-17/AC4: the Jira comment carries the same computed lines in wiki markup and ADF", () => {
    const { wiki, adf } = renderRegressionComment(model());
    expect(wiki).toContain("h3. QAJitsu regression run");
    expect(wiki).toContain("h4. Regressions (passed when promoted, fail now)");
    expect(wiki).toContain("* SHOP\\-1 TC\\-02 FAILED: Codes (S1 total)");
    expect(JSON.stringify(adf)).toContain("Packs that could not run");
    const clean = renderRegressionComment(model({ cases: [model().cases[0]!], problems: [] }));
    expect(clean.wiki).not.toContain("h4.");
  });
});
