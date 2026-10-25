import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { checkPlanCoverage, endpointReach, formatCoverageGaps } from "./coverage.js";

const criteria = [
  "GET /cart returns total = sum of (unit price × quantity) for all lines, rounded once to 2 decimals.",
  "POST /cart/discount with a valid code reduces the total by the code's percentage.",
  "Applying a second code replaces the first; codes never stack.",
  "An unknown code returns 404 with error code DISCOUNT_NOT_FOUND and leaves the total unchanged.",
];
const draft = JSON.parse(
  readFileSync(new URL("../../../fixtures/plans/demo-1-draft.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const plan = (edit: (p: Record<string, unknown>) => void = () => undefined) => {
  const p = structuredClone(draft);
  edit(p);
  return PlanSchema.parse({ schema: 1, ticket: "DEMO-1", version: 1, ...p });
};
const endpoints = [
  { method: "GET", path: "/cart" },
  { method: "POST", path: "/orders/{id}/cancel" },
];

describe("coverage computed by code (REQ-PLAN-14)", () => {
  it("REQ-PLAN-14/AC1+AC2: criteria are covered by a case's ac source, a quote of them, an existing test or an exclusion with a reason; endpoints by a case that calls them", () => {
    const covered = plan((p) => {
      p["out_of_scope"] = [
        "AC2: the percentage is checked by the pricing service's own tests",
        "POST /orders/{id}/cancel: not part of this change's behaviour",
      ];
      p["existing_coverage"] = [{ repo: "tests", file: "a.spec.ts", title: "unknown code", covers: ["AC4"] }];
    });
    expect(checkPlanCoverage(covered, { acceptanceCriteria: criteria, endpoints })).toEqual([]);
  });

  it("REQ-PLAN-14/AC1+AC2+AC3: what no case covers is listed with what to do", () => {
    // The fixture excludes AC2 and AC4 on purpose; without those exclusions they are gaps.
    const gaps = checkPlanCoverage(
      plan((p) => {
        p["out_of_scope"] = [];
      }),
      { acceptanceCriteria: criteria, endpoints },
    );
    expect(gaps.map((g) => g.id)).toEqual(["AC2", "AC4", "POST /orders/{id}/cancel"]);
    expect(formatCoverageGaps(gaps)).toBe(
      [
        '  ? AC2 "POST /cart/discount with a valid code reduces the total by the code\'s percentage."',
        '  ? AC4 "An unknown code returns 404 with error code DISCOUNT_NOT_FOUND and leaves the total unchanged."',
        "  ? POST /orders/{id}/cancel changed in the diff",
        '  Add a case, or exclude each on purpose in out_of_scope with a reason, e.g. "AC2: why".',
      ].join("\n"),
    );
  });

  it("REQ-PLAN-14/AC1: an exclusion needs a reason; a bare id or a mention in passing does not count", () => {
    const gaps = checkPlanCoverage(
      plan((p) => {
        p["out_of_scope"] = ["AC2", "Discount codes like in AC4 are fun", "GET /cart-items — not changed"];
      }),
      { acceptanceCriteria: criteria, endpoints: [] },
    );
    expect(gaps.map((g) => g.id)).toEqual(["AC2", "AC4"]);
  });

  it("REQ-PLAN-14/AC2: a templated endpoint is covered by a call with a real id; a call to another endpoint is not", () => {
    const withCancel = plan((p) => {
      const cases = p["cases"] as { steps: { action: string }[] }[];
      const step = cases[0]?.steps[0];
      if (step) step.action = "POST /orders/42/cancel";
    });
    expect(checkPlanCoverage(withCancel, { acceptanceCriteria: [], endpoints }).map((g) => g.id)).toEqual([
      "GET /cart",
    ]);
  });

  it("REQ-PLAN-14/AC2: a changed page is covered by a web case that opens it; an API case or another page does not count (dogfood 2026-10-25)", () => {
    const web = (type: string, action: string) =>
      PlanSchema.parse({
        schema: 1,
        ticket: "DEMO-11",
        version: 1,
        summary: "s",
        cases: [
          {
            id: "TC-01",
            title: "Notes",
            type,
            priority: "high",
            source: [{ kind: "ac", id: "AC1" }],
            evidence: ["screenshot"],
            steps: [{ id: "S1", action, expect: { description: "d", texts: ["Notes"] } }],
          },
        ],
      });
    const pages = [{ path: "/app/notes" }];
    const gaps = (type: string, action: string) =>
      checkPlanCoverage(web(type, action), { acceptanceCriteria: [], endpoints: pages }).map((g) => g.id);
    expect(gaps("web", "Navigate to Notes Page (/app/notes)")).toEqual([]);
    expect(gaps("web", "Open /app/notes, go offline")).toEqual([]);
    expect(gaps("web", "Open /app/notes-archive")).toEqual(["/app/notes"]);
    expect(gaps("api", "Open /app/notes")).toEqual(["/app/notes"]);
  });

  it("REQ-EVD-09/AC2: which case reached which changed endpoint, from recorded requests only", () => {
    const reached = new Map([
      [
        "TC-01",
        [
          { method: "POST", path: "/orders/42/cancel" },
          { method: "GET", path: "/app/notes" },
        ],
      ],
      ["TC-02", [{ method: "GET", path: "/orders/42" }]],
      ["TC-03", []],
    ]);
    expect(
      endpointReach(
        [
          { method: "POST", path: "/orders/{id}/cancel" },
          { method: "GET", path: "/orders/:id" },
          { path: "/app/notes" },
          { method: "DELETE", path: "/orders/{id}" },
        ],
        reached,
      ),
    ).toEqual([
      { id: "POST /orders/{id}/cancel", cases: ["TC-01"] },
      { id: "GET /orders/:id", cases: ["TC-02"] },
      { id: "/app/notes", cases: ["TC-01"] },
      { id: "DELETE /orders/{id}", cases: [] },
    ]);
  });
});
