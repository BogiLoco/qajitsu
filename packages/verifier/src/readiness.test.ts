import { describe, expect, it } from "vitest";
import { checkReadiness, formatReadiness, type ReadinessInput } from "./readiness.js";

const ready: ReadinessInput = {
  ticket: {
    summary: "Cart total with discount codes",
    description: "The cart endpoint returns line totals and a cart total in PLN with two decimals.",
    acceptanceCriteria: ["GET /cart returns the total rounded once to 2 decimals."],
  },
  codeAccess: "full",
  changes: 1,
  changedFiles: ["api/cart.ts", "README.md"],
  environmentKnown: true,
  analysis: { confidence: "high", open_questions: [], risks: [] },
};

describe("ticket readiness gate (REQ-PLAN-13)", () => {
  it("REQ-PLAN-13/AC1+AC4: a ticket with criteria, a change and an environment is READY with a low risk", () => {
    expect(checkReadiness(ready)).toEqual({
      result: "READY",
      risk: "low",
      riskReasons: [],
      gaps: [],
      questions: [],
    });
  });

  it("REQ-PLAN-13/AC1+AC2: every missing piece is a gap with a concrete question; nothing to test at all is NOT_TESTABLE", () => {
    const unclear = checkReadiness({
      ...ready,
      ticket: { ...ready.ticket, acceptanceCriteria: [" "] },
      changes: 0,
      environmentKnown: false,
      analysis: {
        confidence: "low",
        open_questions: [{ question: "Is the discount applied before rounding?" }],
        risks: [],
      },
    });
    expect(unclear.result).toBe("NEEDS_CLARIFICATION");
    expect(unclear.gaps).toEqual([
      "no acceptance criteria",
      "no change found for the ticket",
      "no default environment yet: set environments.default or pass --env to qj run",
      "the scope is not clear enough to plan",
    ]);
    expect(unclear.questions).toEqual([
      "What must be true when this ticket is done? Please add acceptance criteria.",
      "Which pull or merge request, or branch, implements this ticket?",
      "Is the discount applied before rounding?",
    ]);
    expect(
      checkReadiness({ ...ready, ticket: { summary: "Fix", description: "", acceptanceCriteria: [] } })
        .result,
    ).toBe("NOT_TESTABLE");
    // Without code access no change is expected; open questions of a confident analysis are gaps, not blockers.
    const noCode = checkReadiness({
      ...ready,
      codeAccess: "none",
      changes: 0,
      changedFiles: [],
      analysis: { confidence: "medium", open_questions: [{ question: "Which currency?" }], risks: [] },
    });
    expect(noCode).toMatchObject({
      result: "READY",
      gaps: ["open question: Which currency?"],
      questions: [],
    });
    expect(noCode.riskReasons).toEqual(["the change itself could not be looked at (code access none)"]);
  });

  it("REQ-PLAN-13/AC5: the risk is computed by rules from the change; project rules add to them; the analyst adds reasons but never lowers it", () => {
    const r = checkReadiness({
      ...ready,
      changedFiles: [
        "db/migrations/0042_discounts.sql",
        "api/auth/session.ts",
        ".github/workflows/deploy.yml",
      ],
      ticket: { ...ready.ticket, labels: ["payments"] },
      analysis: {
        confidence: "high",
        open_questions: [],
        risks: [{ description: "rounding is a known weak spot" }],
      },
    });
    expect(r.risk).toBe("high");
    expect(r.riskReasons).toEqual([
      "high: database migration (db/migrations/0042_discounts.sql)",
      "high: authentication or security code (api/auth/session.ts)",
      "medium: build, deployment or infrastructure (.github/workflows/deploy.yml)",
      'high: the ticket is marked "payments"',
      "analyst: rounding is a known weak spot",
    ]);
    const custom = checkReadiness({
      ...ready,
      rules: [{ pattern: "^api/cart", level: "medium", reason: "the cart" }],
    });
    expect(custom).toMatchObject({ risk: "medium", riskReasons: ["medium: the cart (api/cart.ts)"] });
    const many = (n: number) => Array.from({ length: n }, (_, i) => `src/f${String(i)}.ts`);
    expect(checkReadiness({ ...ready, changedFiles: many(25) }).risk).toBe("medium");
    expect(checkReadiness({ ...ready, changedFiles: many(60) }).risk).toBe("high");
    expect(
      checkReadiness({ ...ready, changedFiles: ["a.ts", "b.ts", "c.ts", "d.ts"].map((f) => `auth/${f}`) })
        .riskReasons[0],
    ).toBe("high: authentication or security code (auth/a.ts, auth/b.ts, auth/c.ts, …)");
  });

  it("REQ-PLAN-13/AC4: the result as lines with risk, gaps and numbered questions", () => {
    expect(
      formatReadiness({
        result: "NEEDS_CLARIFICATION",
        risk: "high",
        riskReasons: ["high: payments (api/pay.ts)"],
        gaps: ["no acceptance criteria"],
        questions: ["What must be true?"],
      }),
    ).toEqual([
      "Readiness: NEEDS_CLARIFICATION · risk high",
      "  risk high: payments (api/pay.ts)",
      "  gap: no acceptance criteria",
      "Questions before testing:",
      "  1. What must be true?",
    ]);
  });
});
