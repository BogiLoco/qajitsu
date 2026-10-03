import { readFileSync } from "node:fs";
import { AnalysisSchema, PlanSchema, TicketKeySchema, type Ticket } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import {
  checkAnalysisSources,
  checkPlanSources,
  checkSource,
  formatSourceIssues,
  indexDiff,
  type SourceContext,
} from "./sources.js";

const diff = readFileSync(new URL("../../../fixtures/github/pull-12.diff", import.meta.url), "utf8");
const gitlabStyle = [
  "diff --git a/src/old.ts b/src/new.ts",
  "rename from src/old.ts",
  "rename to src/new.ts",
  "diff --git a/src/removed.ts b/src/removed.ts",
  "deleted file mode 100644",
  "--- a/src/removed.ts",
  "+++ /dev/null",
  "@@ -5,3 +0,0 @@",
  "-a",
  "diff --git a/one.ts b/one.ts",
  "@@ -1 +1 @@",
  "-x",
  "+y",
].join("\n");

const ticket: Ticket = {
  key: TicketKeySchema.parse("DEMO-1"),
  summary: "Cart total with discount codes",
  description: "The cart endpoint returns line totals and a cart total in PLN with **two decimals**.",
  issueType: "Story",
  status: "Ready",
  labels: [],
  components: [],
  acceptanceCriteria: ["Total rounded once.", "Codes never stack."],
  comments: [{ author: "po", body: "Codes are percentage only for now.", created: "x" }],
  linkedKeys: [],
  attachments: [],
  developmentLinks: [],
};
const context: SourceContext = {
  ticket,
  diffs: { web: indexDiff(diff), api: indexDiff(gitlabStyle) },
  comments: { web: [{ author: "r", body: "ok" }] },
};

describe("grounded sources (REQ-PLAN-03)", () => {
  it.each([
    [{ kind: "ac", id: "AC2" }, undefined],
    [{ kind: "ac", id: "AC3" }, /does not exist/],
    [{ kind: "quote", text: "cart total in PLN with two decimals" }, undefined],
    [{ kind: "quote", text: "Codes are  percentage only" }, undefined],
    [{ kind: "quote", text: "Codes may stack on weekends" }, /not verbatim/],
    [{ kind: "diff", repo: "web", file: "src/cart/total.ts", lines: "2-3" }, undefined],
    [{ kind: "diff", repo: "web", file: "src/cart/total.ts" }, undefined],
    [{ kind: "diff", repo: "web", file: "src/cart/total.ts", lines: "40-50" }, /outside the changed hunks/],
    [{ kind: "diff", repo: "web", file: "src/cart/total.ts", lines: "9-2" }, /invalid line range/],
    [{ kind: "diff", repo: "web", file: "src/other.ts" }, /not changed/],
    [{ kind: "diff", repo: "mobile", file: "a.ts" }, /no diff/],
    [{ kind: "diff", repo: "api", file: "src/old.ts" }, undefined],
    [{ kind: "diff", repo: "api", file: "src/removed.ts", lines: "6" }, undefined],
    [{ kind: "diff", repo: "api", file: "one.ts", lines: "1" }, undefined],
    [{ kind: "comment", repo: "web", index: 0 }, undefined],
    [{ kind: "comment", repo: "web", index: 1 }, /does not exist/],
    [{ kind: "comment", repo: "api", index: 0 }, /does not exist/],
  ] as const)("REQ-PLAN-03/AC1+AC2: %j", (source, expected) => {
    const reason = checkSource(source, context);
    if (expected === undefined) expect(reason).toBeUndefined();
    else expect(reason).toMatch(expected);
  });

  it("REQ-PLAN-03/AC2: rejects a plan listing the offending cases", () => {
    const plan = PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-1",
      version: 1,
      cases: [
        {
          id: "TC-01",
          title: "grounded",
          type: "api",
          priority: "high",
          source: [{ kind: "ac", id: "AC1" }],
          steps: [{ id: "S1", action: "a", expect: { description: "d" } }],
          evidence: ["response"],
        },
        {
          id: "TC-02",
          title: "invented",
          type: "api",
          priority: "low",
          source: [{ kind: "quote", text: "Admins get free shipping" }],
          steps: [{ id: "S1", action: "a", expect: { description: "d" } }],
          evidence: ["response"],
        },
      ],
    });
    const issues = checkPlanSources(plan, context);
    expect(issues.map((i) => i.where)).toEqual(["cases.TC-02"]);
    expect(formatSourceIssues(issues)).toContain("cases.TC-02");
  });

  it("REQ-PLAN-01/AC2: checks every analysis claim", () => {
    const analysis = AnalysisSchema.parse({
      summary: "s",
      change_type: ["api"],
      confidence: "high",
      endpoints: [{ path: "/cart", source: [{ kind: "ac", id: "AC9" }] }],
      screens: [{ name: "Cart", source: [{ kind: "ac", id: "AC1" }] }],
      risks: [{ description: "r", source: [{ kind: "comment", repo: "web", index: 5 }] }],
    });
    expect(checkAnalysisSources(analysis, context).map((i) => i.where)).toEqual(["endpoints.0", "risks.0"]);
  });
});
