import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { checkPlanExpectations, formatPlanFlags, isPlaceholder } from "./plan-quality.js";
import { buildUiInventory } from "./ui-inventory.js";

const openapi = parse(
  readFileSync(new URL("../../../examples/demo-shop/api/openapi.yaml", import.meta.url), "utf8"),
) as unknown;
const inventory = buildUiInventory([
  {
    path: "api/web.mjs",
    text: readFileSync(new URL("../../../examples/demo-shop/api/web.mjs", import.meta.url), "utf8"),
  },
]);

const plan = (steps: Record<string, unknown>[], type = "api") =>
  PlanSchema.parse({
    schema: 1,
    ticket: "DEMO-1",
    version: 1,
    summary: "s",
    cases: [
      {
        id: "TC-01",
        title: "A case",
        type,
        priority: "high",
        source: [{ kind: "ac", id: "AC1" }],
        evidence: ["response"],
        steps: steps.map((s, i) => ({ id: `S${String(i + 1)}`, action: "x", ...s })),
      },
    ],
  });

describe("concrete expected values (REQ-PLAN-09)", () => {
  it.each([
    "expected_rounded_value",
    "reduced_value",
    "original_total",
    "intermediate_value",
    "expectedTotal",
    "<total>",
    "{total}",
    "{{total}}",
    "price ${total}",
    "TBD",
    "todo",
    "?",
    "...",
    "N/A",
    "X,XX zł",
  ])("REQ-PLAN-09/AC1: %s is a placeholder", (value) => {
    expect(isPlaceholder(value)).toBe(true);
  });

  it.each(["DISCOUNT_NOT_FOUND", "pending_payment", "Order placed", "24,99 zł", "standard", "", "value"])(
    "REQ-PLAN-09/AC1+AC5: %j is a real value",
    (value) => {
      expect(isPlaceholder(value)).toBe(false);
    },
  );

  it("REQ-PLAN-09/AC1: placeholders in fields, texts, elements and messages are flagged, wrapped values too", () => {
    const flags = checkPlanExpectations(
      plan([
        {
          expect: {
            description: "d",
            status: 200,
            fields: { total: "expected_rounded_value", lines: [{ name: "TBD" }] },
          },
        },
        { expect: { description: "d", texts: ["X,XX zł"], message: { subject: "<subject>" } } },
        { expect: { description: "d", fields: { total: { value: 10.05 } } } },
      ]),
    );
    expect(flags.map((f) => [f.stepId, f.kind, f.field])).toEqual([
      ["S1", "placeholder", "fields.total"],
      ["S1", "placeholder", "fields.lines.0.name"],
      ["S2", "placeholder", "texts.0"],
      ["S2", "placeholder", "message.subject"],
      ["S3", "placeholder", "fields.total"],
    ]);
    expect(formatPlanFlags(flags.slice(0, 1))).toBe(
      '  ! TC-01 S1 fields.total = "expected_rounded_value": looks like a placeholder, not a value to compare',
    );
  });

  it("REQ-PLAN-09/AC2: fields are checked against the OpenAPI response of the step's call", () => {
    const flags = checkPlanExpectations(
      plan([
        { action: "GET /cart", expect: { description: "d", status: 200, fields: { total: "10.05" } } },
        {
          action: "POST /cart/discount with SAVE10",
          expect: { description: "d", status: 404, fields: { error_code: "DISCOUNT_NOT_FOUND" } },
        },
        {
          action: "POST /cart/discount",
          expect: { description: "d", status: 404, fields: { error: "DISCOUNT_NOT_FOUND" } },
        },
        {
          action: "GET /cart",
          expect: { description: "d", fields: { total: 10.05, "lines.0.quantity": 3 } },
        },
        { action: "Open the cart", expect: { description: "d", fields: { anything: 1 } } },
      ]),
      { openapi },
    );
    expect(flags.map((f) => [f.stepId, f.kind, f.reason])).toEqual([
      ["S1", "schema", 'GET /cart 200: the response field is "number", the plan expects string "10.05"'],
      [
        "S2",
        "schema",
        'POST /cart/discount 404: "error_code" is not a field of the response (fields: error)',
      ],
    ]);
  });

  it("REQ-PLAN-09/AC6: a step that is not manual and expects a description only is flagged", () => {
    const flags = checkPlanExpectations(
      plan([
        { expect: { description: "Prices are in Polish format" } },
        { manual: true, instructions: "Look at the receipt", expect: { description: "Printed" } },
        { expect: { description: "d", visual: { name: "checkout" } } },
      ]),
    );
    expect(flags).toEqual([
      {
        caseId: "TC-01",
        stepId: "S1",
        kind: "description-only",
        reason: "the step expects a description only: the test would have nothing to compare",
      },
    ]);
  });

  it("REQ-PLAN-09/AC8: testid selectors must exist in the code under test; other selectors are not judged", () => {
    const steps = [
      {
        expect: {
          description: "d",
          elements: {
            "testid:place-order": { enabled: false },
            "testid:price-P-2": { text: "24,99 zł" },
            "testid:Price_Item1": { text: "24,99 zł" },
            "text:Total": { visible: true },
          },
        },
      },
    ];
    const flags = checkPlanExpectations(plan(steps, "web"), { inventory });
    expect(flags.map((f) => [f.kind, f.field])).toEqual([["selector", "elements.testid:Price_Item1"]]);
    // Without any element in the code (e.g. the app is not in the repositories) nothing can be judged.
    expect(checkPlanExpectations(plan(steps, "web"), { inventory: { selectors: [], pages: [] } })).toEqual(
      [],
    );
  });

  it("REQ-PLAN-09/AC8: a mobile case may only name ids of the app, a web case only ids of the pages", () => {
    const both = buildUiInventory([
      { path: "web.html", text: '<a data-testid="nav-checkout">' },
      { path: "Cart.java", text: 'v.setContentDescription("open-checkout");' },
    ]);
    const elements = { "testid:nav-checkout": { enabled: true }, "testid:open-checkout": { visible: true } };
    const fields = (type: string) =>
      checkPlanExpectations(plan([{ expect: { description: "d", elements } }], type), {
        inventory: both,
      }).map((f) => [f.field, f.reason]);
    expect(fields("mobile")).toEqual([
      ["elements.testid:nav-checkout", "testid:nav-checkout is not defined in the code of the mobile app"],
    ]);
    expect(fields("web")).toEqual([
      ["elements.testid:open-checkout", "testid:open-checkout is not defined in the code of the web pages"],
    ]);
    // A mobile case with no app ids in the code at all cannot be judged.
    expect(
      checkPlanExpectations(plan([{ expect: { description: "d", elements } }], "mobile"), { inventory }),
    ).toEqual([]);
  });

  it("REQ-PLAN-09/AC2: references, allOf, arrays, open objects and every way a call has no schema", () => {
    const doc = {
      paths: {
        "/orders/{id}": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/Order" } } } },
              "204": { description: "empty" },
              "302": { content: { "text/html": {} } },
            },
          },
          delete: { description: "no responses" },
        },
        "/external": {
          get: {
            responses: { "200": { content: { "application/json": { schema: { $ref: "other.yaml#/X" } } } } },
          },
        },
        "/only-errors": { get: { responses: { "500": {} } } },
      },
      components: {
        schemas: {
          Order: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              {
                type: "object",
                properties: { lines: { type: "array", items: { $ref: "#/components/schemas/Line" } } },
              },
              { description: "no properties" },
            ],
          },
          Base: {
            type: "object",
            properties: {
              id: { type: "integer" },
              note: { type: ["string", "null"] },
              meta: { type: "object", additionalProperties: true, properties: {} },
            },
          },
          Line: { type: "object", properties: { quantity: { type: "integer" }, name: {} } },
        },
      },
    };
    const step = (action: string, fields: Record<string, unknown>, status?: number) => ({
      action,
      expect: { description: "d", fields, ...(status !== undefined ? { status } : {}) },
    });
    const flags = checkPlanExpectations(
      plan([
        step("GET /orders/7", {
          id: 1.5,
          note: null,
          "lines.0.quantity": 2,
          "lines.0.name": "x",
          "meta.anything": 1,
          "lines.0.missing": 1,
        }),
        step("GET /orders/7", { id: 3 }, 204),
        step("GET /orders/7", { id: 3 }, 302),
        step("DELETE /orders/7", { id: 3 }),
        step("GET /external", { id: 3 }),
        step("GET /only-errors", { id: 3 }),
        step("GET /nowhere", { id: 3 }),
        step("PATCH /orders/7", { id: 3 }),
      ]),
      { openapi: doc },
    );
    expect(flags.map((f) => [f.stepId, f.field, f.reason])).toEqual([
      ["S1", "fields.id", 'GET /orders/7 200: the response field is "integer", the plan expects number 1.5'],
      [
        "S1",
        "fields.lines.0.missing",
        'GET /orders/7 200: "missing" is not a field of the response (fields: quantity, name)',
      ],
    ]);
    // A document that is not an object checks nothing.
    expect(
      checkPlanExpectations(plan([step("GET /orders/7", { id: "x" })]), { openapi: "not a document" }),
    ).toEqual([]);
    // A $ref loop ends instead of hanging.
    const loop = {
      paths: {
        "/a": {
          get: {
            responses: {
              "200": { content: { "application/json": { schema: { $ref: "#/components/schemas/A" } } } },
            },
          },
        },
      },
      components: { schemas: { A: { $ref: "#/components/schemas/A" } } },
    };
    expect(checkPlanExpectations(plan([step("GET /a", { id: "x" })]), { openapi: loop })).toEqual([]);
  });
});
