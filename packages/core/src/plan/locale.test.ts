import { describe, expect, it } from "vitest";
import { planForLocale } from "./locale.js";
import { PlanSchema } from "./schemas.js";

const base = {
  schema: 1,
  ticket: "DEMO-6",
  version: 1,
  summary: "Prices per locale",
  open_questions: [],
  out_of_scope: [],
};
const caseWith = (expect: Record<string, unknown>, locales?: string[]) => ({
  id: "TC-01",
  title: "Price is formatted for the locale",
  type: "web",
  priority: "high",
  source: [{ kind: "ac", id: "AC1" }],
  ...(locales ? { locales } : {}),
  steps: [{ id: "S1", action: "Open the product page", expect }],
  evidence: ["screenshot"],
});

describe("locales in the plan (REQ-EXEC-14)", () => {
  it("REQ-EXEC-14/AC2: a locale's plan takes its own number, date and currency formats; the approved plan is unchanged", () => {
    const plan = PlanSchema.parse({
      ...base,
      cases: [
        caseWith(
          {
            description: "Price and date are formatted",
            fields: { price: "$1,234.50", currency: "USD" },
            texts: ["Delivery on 10/07/2026"],
            elements: { "testid:price": { text: "$1,234.50", visible: true } },
            by_locale: {
              "pl-PL": {
                fields: { price: "1 234,50 zł" },
                texts: ["Dostawa 07.10.2026"],
                elements: { "testid:price": { text: "1 234,50 zł" } },
              },
            },
          },
          ["pl-PL", "de-DE"],
        ),
      ],
    });
    const pl = planForLocale(plan, "pl-PL");
    expect(pl.cases[0]?.steps[0]?.expect).toMatchObject({
      fields: { price: "1 234,50 zł", currency: "USD" },
      texts: ["Dostawa 07.10.2026"],
      elements: { "testid:price": { text: "1 234,50 zł", visible: true } },
    });
    // A locale without overrides keeps the base values; a locale the case does not run in has no cases.
    expect(planForLocale(plan, "de-DE").cases[0]?.steps[0]?.expect.fields).toEqual({
      price: "$1,234.50",
      currency: "USD",
    });
    expect(planForLocale(plan, "fr-FR").cases).toEqual([]);
    expect(plan.cases[0]?.steps[0]?.expect.fields).toEqual({ price: "$1,234.50", currency: "USD" });
  });

  it("REQ-EXEC-14/AC2: a locale can only change planned values, never add expectations", () => {
    const parse = (expect: Record<string, unknown>) =>
      PlanSchema.safeParse({ ...base, cases: [caseWith(expect, ["pl-PL"])] }).success;
    expect(
      parse({ description: "d", fields: { price: "1" }, by_locale: { "pl-PL": { fields: { price: "2" } } } }),
    ).toBe(true);
    expect(
      parse({ description: "d", fields: { price: "1" }, by_locale: { "pl-PL": { fields: { tax: "2" } } } }),
    ).toBe(false);
    expect(parse({ description: "d", texts: ["a"], by_locale: { "pl-PL": { texts: ["b", "c"] } } })).toBe(
      false,
    );
    expect(
      parse({
        description: "d",
        elements: { "testid:x": { visible: true } },
        by_locale: { "pl-PL": { elements: { "testid:x": { text: "y" } } } },
      }),
    ).toBe(false);
    expect(parse({ description: "d", by_locale: { "Polish!": {} } })).toBe(false);
  });
});
