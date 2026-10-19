import { describe, expect, it } from "vitest";
import { CliExploreSessionSchema } from "./cli-session.js";
import { acceptedItems, recordDecisions, reviewItems, ReviewRecordSchema } from "./review.js";
import { ExploreSessionSchema } from "./session.js";

const browser = ExploreSessionSchema.parse({
  schema: 1,
  id: "S01",
  ticket: "DEMO-1",
  run: "20261018-1000-aaaa",
  goal: "Cart",
  environment: { name: "local", baseUrl: "http://127.0.0.1:3000" },
  model: "local/m",
  startedAt: "t0",
  endedAt: "t1",
  endReason: "finished",
  budget: { minutes: 10, steps: 10 },
  summary: "",
  checklist: [
    { item: "open the cart", source: "person", actions: ["A01"] },
    { item: "pay with a saved card", source: "person", actions: [], notDone: "no saved card" },
  ],
  findings: [{ text: "the total shows three decimals", actions: ["A01"] }],
  actions: [
    {
      id: "A01",
      action: "goto",
      target: "/app/cart",
      ok: true,
      url: "http://127.0.0.1:3000/app/cart",
      at: "t",
    },
  ],
  observations: [
    {
      id: "O1",
      title: "Total has three decimals",
      kind: "possible-bug",
      severity: "medium",
      description: "1.005 instead of 1.01",
      steps: ["A01"],
      expected: "two decimals",
      actual: "1.005",
    },
  ],
  recordings: [],
});

describe("review of exploratory sessions (REQ-PLAN-11)", () => {
  it("REQ-PLAN-11/AC1: observations, findings and not-done checklist items are the items to review", () => {
    expect(reviewItems(browser)).toEqual([
      {
        id: "O1",
        kind: "observation",
        title: "Total has three decimals",
        detail: "possible-bug, medium: 1.005 instead of 1.01 (expected: two decimals; actual: 1.005)",
        actions: ["A01"],
      },
      { id: "F1", kind: "finding", title: "the total shows three decimals", detail: "", actions: ["A01"] },
      {
        id: "C2",
        kind: "not-done",
        title: "pay with a saved card",
        detail: "not done: no saved card",
        actions: [],
      },
    ]);
    const cli = CliExploreSessionSchema.parse({
      schema: 1,
      kind: "cli",
      id: "S02",
      ticket: "DEMO-1",
      run: "r",
      goal: "g",
      tool: { name: "qj", command: ["qj"] },
      model: "m",
      startedAt: "t0",
      endedAt: "t1",
      endReason: "finished",
      budget: { minutes: 1, steps: 1 },
      actions: [],
      observations: [],
      leftovers: { processes: [], containers: [] },
      cleaned: { processes: [], containers: [] },
    });
    expect(reviewItems(cli)).toEqual([]);
  });

  it("REQ-PLAN-11/AC1+AC2: decisions are kept with who and when; the latest one counts; a changed session voids them", () => {
    const first = recordDecisions(undefined, {
      session: "S01",
      sessionSha256: "a".repeat(64),
      items: reviewItems(browser),
      decisions: [
        { item: "O1", decision: "accepted" },
        { item: "F1", decision: "rejected", note: "expected behaviour" },
      ],
      by: "qa-lead",
      at: "2026-10-18T10:00:00Z",
    });
    const second = recordDecisions(first, {
      session: "S01",
      sessionSha256: "a".repeat(64),
      items: reviewItems(browser),
      decisions: [
        { item: "C2", decision: "accepted" },
        { item: "F1", decision: "accepted" },
      ],
      by: "qa-lead",
      at: "2026-10-18T10:05:00Z",
    });
    expect(ReviewRecordSchema.parse(second).decisions).toHaveLength(4);
    expect(acceptedItems(second, "a".repeat(64))).toEqual(["O1", "C2", "F1"]);
    // REQ-PLAN-11/AC2: the session changed after the decisions: none of them counts any more.
    expect(acceptedItems(second, "b".repeat(64))).toEqual([]);
    // An item that is not in the session is refused, and so is an agent (only a person decides).
    expect(() =>
      recordDecisions(undefined, {
        session: "S01",
        sessionSha256: "a".repeat(64),
        items: reviewItems(browser),
        decisions: [{ item: "O7", decision: "accepted" }],
        by: "qa-lead",
        at: "t",
      }),
    ).toThrow("O7 is not an item of session S01 (items: O1, F1, C2)");
  });
});
