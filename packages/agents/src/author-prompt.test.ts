import { PlanSchema } from "@qajitsu/core";
import { checkSpecSource } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";
import { AUTHOR_SYSTEM, EXAMPLE_SPEC, EXAMPLE_WEB_SPEC } from "./author.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-4",
  version: 1,
  summary: "Examples of the author prompt.",
  cases: [
    {
      id: "TC-07",
      title: "API example",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      evidence: ["response"],
      steps: [
        {
          id: "S1",
          action: "Add an item and read it",
          expect: { description: "Item stored", status: 200, fields: { quantity: 2 } },
        },
      ],
    },
    {
      id: "TC-08",
      title: "Web example",
      type: "web",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      evidence: ["screenshot"],
      steps: [
        {
          id: "S1",
          action: "Open checkout",
          expect: { description: "Disabled", elements: { "testid:place-order": { enabled: false } } },
        },
        {
          id: "S2",
          action: "Accept the terms",
          expect: {
            description: "Enabled",
            elements: { "testid:place-order": { enabled: true } },
            texts: ["Place order"],
          },
        },
      ],
    },
  ],
});

describe("author prompt (REQ-EXEC-01, REQ-EXEC-05)", () => {
  it("REQ-EXEC-01/AC1 + REQ-EXEC-05/AC1: the API and web examples the author is shown pass the static checks", () => {
    expect(checkSpecSource(EXAMPLE_SPEC, "TC-07", plan)).toEqual([]);
    expect(checkSpecSource(EXAMPLE_WEB_SPEC, "TC-08", plan)).toEqual([]);
    expect(AUTHOR_SYSTEM).toContain(EXAMPLE_WEB_SPEC);
    expect(AUTHOR_SYSTEM).toContain('"elements.<selector>.<property>"');
  });
});
