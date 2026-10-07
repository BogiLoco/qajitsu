import { readFileSync } from "node:fs";
import { AnalysisSchema, PlanSchema, TicketKeySchema, type Ticket } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import {
  checkAnalysisSources,
  checkExistingCoverage,
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

describe("existing coverage claims (REQ-CTX-06/AC2)", () => {
  const plan = (coverage: unknown[]) =>
    PlanSchema.parse({
      schema: 1,
      ticket: "DEMO-1",
      version: 1,
      cases: [
        {
          id: "TC-01",
          title: "Cart total",
          type: "api",
          priority: "high",
          source: [{ kind: "ac", id: "AC1" }],
          steps: [{ id: "S1", action: "GET /cart", expect: { description: "ok", status: 200 } }],
          evidence: ["response"],
        },
      ],
      existing_coverage: coverage,
    });
  const tests = { e2e: [{ file: "tests/cart.spec.ts", titles: ["codes never stack"] }] };

  it("REQ-CTX-06/AC2: a claim must name a real test of the tests repository and a real criterion", () => {
    const ok = plan([
      { repo: "e2e", file: "tests/cart.spec.ts", title: "codes never stack", covers: ["AC2"] },
    ]);
    expect(checkExistingCoverage(ok, { ...context, tests })).toEqual([]);
    const invented = plan([
      { repo: "e2e", file: "tests/cart.spec.ts", title: "codes stack forever", covers: ["AC2"] },
      { repo: "e2e", file: "tests/none.spec.ts", title: "x", covers: ["AC1"] },
      { repo: "web", file: "tests/cart.spec.ts", title: "codes never stack", covers: ["AC1"] },
      { repo: "e2e", file: "tests/cart.spec.ts", title: "codes never stack", covers: ["AC9"] },
    ]);
    expect(checkExistingCoverage(invented, { ...context, tests })).toEqual([
      "existing_coverage.0: no test 'codes stack forever' in e2e:tests/cart.spec.ts",
      "existing_coverage.1: e2e has no test file tests/none.spec.ts",
      "existing_coverage.2: web is not a tests repository of this run",
      "existing_coverage.3: AC9 is not an acceptance criterion of the ticket",
    ]);
  });
});

describe("observations as sources (REQ-EXEC-15/AC4)", () => {
  it("REQ-EXEC-15/AC4: a case may cite an observation of an exploratory session of the run, and only one that exists", () => {
    const withSessions: SourceContext = { ...context, observations: { S01: ["O1", "O2"] } };
    expect(checkSource({ kind: "observation", session: "S01", id: "O2" }, withSessions)).toBeUndefined();
    expect(checkSource({ kind: "observation", session: "S01", id: "O9" }, withSessions)).toBe(
      "observation O9 does not exist in exploratory session S01",
    );
    expect(checkSource({ kind: "observation", session: "S02", id: "O1" }, context)).toBe(
      "observation O1 does not exist in exploratory session S02",
    );
  });
});

describe("imported test cases as sources (REQ-CTX-08/AC2)", () => {
  it("REQ-CTX-08/AC2: a case may cite a test case imported for the run, and only one that was", () => {
    const withImported: SourceContext = { ...context, imported: new Set(["testrail:C11"]) };
    expect(checkSource({ kind: "imported", id: "testrail:C11" }, withImported)).toBeUndefined();
    expect(checkSource({ kind: "imported", id: "testrail:C12" }, withImported)).toBe(
      "testrail:C12 is not a test case imported for this run",
    );
    expect(checkSource({ kind: "imported", id: "testrail:C11" }, context)).toBe(
      "testrail:C11 is not a test case imported for this run",
    );
  });
});

describe("application map as a source (REQ-OBS-08)", () => {
  it("REQ-OBS-08/AC1: a case may cite a map id given to the planner, and only one that was", () => {
    const withMap: SourceContext = { ...context, map: new Set(["page:/cart/checkout"]) };
    expect(checkSource({ kind: "map", id: "page:/cart/checkout" }, withMap)).toBeUndefined();
    expect(checkSource({ kind: "map", id: "page:/admin" }, withMap)).toBe(
      "page:/admin is not in the application map around this change",
    );
    expect(checkSource({ kind: "map", id: "page:/cart/checkout" }, context)).toBe(
      "page:/cart/checkout is not in the application map around this change",
    );
  });
});

describe("documentation as a source (REQ-KNOW-06)", () => {
  const chunk = {
    id: "0123456789abcdef-0",
    source: "docs",
    path: "docs/orders.md",
    section: "Orders > Cancel",
    modifiedAt: "2026-09-01T00:00:00.000Z",
    fileHash: "f",
    hash: "h",
    tags: [],
    text: "A paid order can be **cancelled** within 24 hours of payment.",
  };
  const withDocs: SourceContext = { ...context, docs: new Map([[chunk.id, chunk]]) };

  it("REQ-KNOW-06/AC3: a documentation quote must be verbatim in a chunk the run's agents were given", () => {
    const doc = { kind: "doc", chunk: chunk.id, quote: "can be cancelled within 24 hours" } as const;
    expect(checkSource(doc, withDocs)).toBeUndefined();
    expect(checkSource({ ...doc, quote: "can be cancelled within 48 hours" }, withDocs)).toBe(
      "the quote is not in docs/orders.md",
    );
    expect(checkSource(doc, context)).toMatch(/no such documentation chunk/);
    expect(checkSource({ ...doc, chunk: "fedcba9876543210-3" }, withDocs)).toMatch(
      /no such documentation chunk/,
    );
    expect(checkSource({ ...doc, path: "docs/cart.md" }, withDocs)).toBe(
      `chunk ${chunk.id} is from docs/orders.md, not docs/cart.md`,
    );
    expect(checkSource({ ...doc, path: "docs/orders.md" }, withDocs)).toBeUndefined();
  });
});
