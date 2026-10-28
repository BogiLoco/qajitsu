import { readFileSync } from "node:fs";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  checkPlanExpectations,
  convertNumericStrings,
  formatNumericConversions,
  formatPlanFlags,
  isAdvisoryFlag,
  isPlaceholder,
} from "./plan-quality.js";
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
        // A test account, so these cases test what they are about, not REQ-PLAN-09/AC9.
        data: { user: "user:standard" },
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
        // REQ-EXEC-38/AC2 + REQ-EXEC-56/AC2: a download or the application's test state is something to compare.
        { expect: { description: "d", download: { name: "orders.csv" } } },
        { expect: { description: "d", state: { "bars.0": 1 } } },
        // REQ-EXEC-47/AC3 + REQ-EXEC-65/AC3: socket messages and the app manifest too (found by the CLI flow).
        { expect: { description: "d", websocket: { received: ["hello"] } } },
        { expect: { description: "d", manifest: { short_name: "Notes" } } },
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

  it("REQ-PLAN-09/AC8: a text: or label: selector naming an element id of the code is flagged with the testid: to use", () => {
    const app = buildUiInventory([
      { path: "Cart.java", text: 'v.setContentDescription("cart-count");' },
      { path: "web.html", text: '<b data-testid="nav-cart">' },
    ]);
    const elements = {
      "text:cart-count": { text: "Cart: 1 item" },
      "label:cart-count": { visible: true },
      "text:Cart: 1 item": { visible: true },
      "text:nav-cart": { visible: true },
    };
    expect(
      checkPlanExpectations(plan([{ expect: { description: "d", elements } }], "mobile"), {
        inventory: app,
      }).map((f) => [f.field, f.reason]),
    ).toEqual([
      [
        "elements.text:cart-count",
        "cart-count is an element id in the code, not a visible text or label: write testid:cart-count",
      ],
    ]);
    // On the web label: names a form label, never an id; in a native app label: is the accessibility id.
    expect(
      checkPlanExpectations(
        plan([{ expect: { description: "d", elements: { "label:nav-cart": { visible: true } } } }], "web"),
        { inventory: app },
      ).map((f) => f.field),
    ).toEqual(["elements.label:nav-cart"]);
  });

  it("REQ-PLAN-09: a native element expecting a different text and value can never pass and is flagged", () => {
    const elements = {
      "testid:cart-count": { text: "Cart: 1 item", value: "1" },
      "testid:qty": { text: "2", value: "2" },
    };
    expect(
      checkPlanExpectations(plan([{ expect: { description: "d", elements } }], "mobile")).map((f) => [
        f.field,
        f.reason,
      ]),
    ).toEqual([
      [
        "elements.testid:cart-count.value",
        "in a native app text and value of testid:cart-count are the same visible text: expect text only",
      ],
    ]);
    expect(checkPlanExpectations(plan([{ expect: { description: "d", elements } }], "web"))).toEqual([]);
  });

  it("REQ-EXEC-21/AC6: code without any test id cannot judge element names; roles, labels and texts pass", () => {
    const pagesOnly = buildUiInventory([{ path: "app.html", text: '<a href="/orders">Orders</a>' }]);
    expect(pagesOnly.selectors).toEqual([]);
    const elements = {
      "role:button:Submit": { enabled: true },
      "label:Email": { visible: true },
      "text:Order placed": { visible: true },
      "testid:anything": { visible: true },
    };
    expect(
      checkPlanExpectations(plan([{ expect: { description: "d", elements } }], "web"), {
        inventory: pagesOnly,
      }),
    ).toEqual([]);
  });

  it("REQ-EXEC-22/AC8: an element no recorded page shows is flagged, with or without the code", () => {
    const screens = [
      {
        where: "/app/checkout",
        platform: "web" as const,
        elements: [
          { role: "button", name: "Place order", disabled: true },
          { testid: "place-order", role: "button" },
        ],
      },
    ];
    const elements = {
      "role:button:Place order": { enabled: false },
      "testid:place-order": { enabled: false },
      "text:Order placed": { visible: true },
      "role:button:Buy now": { visible: true },
    };
    const flags = (inv?: typeof inventory) =>
      checkPlanExpectations(plan([{ expect: { description: "d", elements } }], "web"), {
        snapshot: screens,
        ...(inv ? { inventory: inv } : {}),
      }).map((f) => [f.kind, f.field, f.reason]);
    expect(flags()).toEqual([
      [
        "selector",
        "elements.text:Order placed",
        "text:Order placed matches no element recorded on the environment's pages",
      ],
      [
        "selector",
        "elements.role:button:Buy now",
        "role:button:Buy now matches no element recorded on the environment's pages",
      ],
    ]);
    // A test id the code defines counts as known even when the page did not show it yet.
    const withCode = checkPlanExpectations(
      plan([{ expect: { description: "d", elements: { "testid:toast": { visible: true } } } }], "web"),
      { snapshot: screens, inventory },
    );
    expect(withCode).toEqual([]);
    // A mobile case is not judged by web pages.
    expect(
      checkPlanExpectations(plan([{ expect: { description: "d", elements } }], "mobile"), {
        snapshot: screens,
      }),
    ).toEqual([]);
  });

  it("REQ-EXEC-22/AC8: an expected text the recorded page shows differently is flagged for a person (dogfood 2026-10-25)", () => {
    const screens = [
      {
        where: "/app/offer",
        platform: "web" as const,
        elements: [
          { testid: "offer-status", text: "Offer active" },
          { testid: "store", text: "" },
        ],
      },
    ];
    const flags = checkPlanExpectations(
      plan(
        [
          {
            expect: {
              description: "d",
              elements: {
                "testid:offer-status": { text: "Active" },
                "testid:store": { text: "Warsaw" },
                "testid:missing": { text: "x" },
              },
            },
          },
          { expect: { description: "d", elements: { "testid:offer-status": { text: "Offer active" } } } },
        ],
        "web",
      ),
      { snapshot: screens },
    ).filter((f) => f.kind === "recorded-text");
    // An empty element (filled later by the page) and an unknown one are not judged by their text.
    expect(flags.map((f) => [f.stepId, f.field, f.reason])).toEqual([
      [
        "S1",
        "elements.testid:offer-status.text",
        'testid:offer-status shows "Offer active" on the recorded pages, the plan expects "Active": confirm the change or an earlier step makes it so, or use the shown text',
      ],
    ]);
    // It asks a person to look; it never blocks the approval (CLI flow 2026-10-28: "Offline" after going offline).
    expect(flags.every((f) => isAdvisoryFlag(f))).toBe(true);
    // A case about the time (an offer that ends) without a clock is told to plan one.
    const timed = checkPlanExpectations(
      plan(
        [
          {
            action: "Open the offer after it ended",
            expect: { description: "d", elements: { "testid:offer-status": { text: "Offer ended" } } },
          },
        ],
        "web",
      ),
      { snapshot: screens },
    ).filter((f) => f.kind === "recorded-text");
    expect(timed[0]?.reason).toContain(
      'a text that depends on the date needs "browser": {"clock": "<ISO time>"}',
    );
    // An invented element for the app manifest is pointed to the manifest check.
    const invented = checkPlanExpectations(
      plan([{ expect: { description: "d", elements: { "testid:manifest": { visible: true } } } }], "web"),
      { snapshot: screens },
    ).filter((f) => f.kind === "selector");
    expect(invented[0]?.reason).toBe(
      'testid:manifest matches no element recorded on the environment\'s pages; the app manifest and its service worker are checked with "manifest": {"short_name": .., "display": .., "controlled": true}',
    );
  });

  it("REQ-EXEC-56/AC2: a state check is flagged when no recorded page exposes the test hook (dogfood 2026-10-28)", () => {
    const step = [{ expect: { description: "d", state: { page: "/app/account" } } }];
    const without = [{ where: "/app/signin", platform: "web" as const, elements: [], testHook: false }];
    expect(
      checkPlanExpectations(plan(step, "web"), { snapshot: without })
        .filter((f) => f.field === "state.page")
        .map((f) => f.reason),
    ).toEqual([
      `state.page needs the application's test hook, and no recorded page exposes one: check what the page shows with "elements" or "texts" instead`,
    ]);
    // A page with the hook, or a snapshot that did not look, is not judged.
    for (const snapshot of [
      [{ where: "/app/chart", platform: "web" as const, elements: [], testHook: true }],
      [{ where: "/app/chart", platform: "web" as const, elements: [] }],
    ])
      expect(
        checkPlanExpectations(plan(step, "web"), { snapshot }).filter((f) => f.field === "state.page"),
      ).toEqual([]);
  });

  it("REQ-EXEC-61/AC1: a web step that checks a dialog without saying how to answer it is flagged (dogfood 2026-10-25)", () => {
    const dialog = { type: "confirm", message: "Delete this address?" };
    const flags = checkPlanExpectations(
      plan(
        [
          { action: "Confirm the deletion", expect: { description: "d", dialog } },
          { action: "Cancel", dialog: { action: "dismiss" }, expect: { description: "d", dialog } },
        ],
        "web",
      ),
    ).filter((f) => f.kind === "dialog");
    expect(flags.map((f) => [f.stepId, f.reason])).toEqual([
      [
        "S1",
        'the step expects a dialog but does not say how to answer it: add "dialog": {"action": "accept"} or {"action": "dismiss"} to the step (unanswered dialogs are dismissed)',
      ],
    ]);
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

  it("REQ-PLAN-09/AC9: a call to an endpoint that answers 401 without login needs a test account in the case", () => {
    const withData = (data: Record<string, unknown>, steps: Record<string, unknown>[]) =>
      PlanSchema.parse({
        schema: 1,
        ticket: "DEMO-1",
        version: 1,
        summary: "s",
        cases: [
          {
            id: "TC-01",
            title: "A case",
            type: "api",
            priority: "high",
            source: [{ kind: "ac", id: "AC1" }],
            data,
            evidence: ["response"],
            steps: steps.map((s, i) => ({
              id: `S${String(i + 1)}`,
              ...s,
              expect: { description: "d", ...(s["expect"] as object) },
            })),
          },
        ],
      });
    const cart = { action: "GET /cart", expect: { status: 200, fields: { total: 1.01 } } };
    // Exploratory testing F18: gemma4 planned the cart without an account; every call got 401 and looked FAILED.
    expect(checkPlanExpectations(withData({}, [cart, cart]), { openapi })).toEqual([
      {
        caseId: "TC-01",
        stepId: "S1",
        kind: "account",
        reason:
          "GET /cart needs a login (401 without one), but the case names no test account: add one to data, e.g. user: user:standard",
      },
    ]);
    expect(checkPlanExpectations(withData({ user: "user:standard" }, [cart]), { openapi })).toEqual([]);
    // A case about the 401 itself, or an endpoint without 401, needs no account; without OpenAPI nothing is known.
    expect(
      checkPlanExpectations(withData({}, [{ action: "GET /cart", expect: { status: 401 } }]), { openapi }),
    ).toEqual([]);
    expect(
      checkPlanExpectations(withData({}, [{ action: "GET /health", expect: { status: 200 } }]), { openapi }),
    ).toEqual([]);
    expect(checkPlanExpectations(withData({}, [cart]))).toEqual([]);
    // Login can also be declared with security instead of a 401 response; `security: []` opts an operation out.
    const secured = {
      openapi: "3.0.3",
      security: [{ bearer: [] }],
      paths: {
        "/orders": { post: { responses: { "201": { description: "created" } } } },
        "/health": { get: { security: [], responses: { "200": { description: "ok" } } } },
      },
    };
    expect(
      checkPlanExpectations(withData({}, [{ action: "POST /orders", expect: { status: 201 } }]), {
        openapi: secured,
      }),
    ).toMatchObject([{ stepId: "S1", kind: "account" }]);
    expect(
      checkPlanExpectations(withData({}, [{ action: "GET /health", expect: { status: 200 } }]), {
        openapi: secured,
      }),
    ).toEqual([]);
  });
});

describe("numbers written as text (REQ-PLAN-12)", () => {
  const cart = (fields: Record<string, unknown>, action = "GET /cart") =>
    plan([{ action, expect: { description: "d", status: 200, fields } }]);
  const order = (fields: Record<string, unknown>) =>
    plan([{ action: "POST /orders", expect: { description: "d", status: 201, fields } }]);

  it("REQ-PLAN-12/AC1+AC3: an exact decimal for a number field becomes that number, every conversion listed", () => {
    const { plan: converted, conversions } = convertNumericStrings(
      cart({ total: "1.01", subtotal: "-3" }),
      openapi,
    );
    expect(converted.cases[0]?.steps[0]?.expect.fields).toEqual({ total: 1.01, subtotal: -3 });
    expect(conversions).toEqual([
      {
        caseId: "TC-01",
        stepId: "S1",
        field: "fields.total",
        from: "1.01",
        to: 1.01,
        where: "GET /cart 200",
      },
      { caseId: "TC-01", stepId: "S1", field: "fields.subtotal", from: "-3", to: -3, where: "GET /cart 200" },
    ]);
    // Converted, nothing is left for the type check to flag.
    expect(checkPlanExpectations(converted, { openapi }).filter((f) => f.kind === "schema")).toEqual([]);
    expect(formatNumericConversions(conversions)).toBe(
      [
        '  ~ TC-01 S1 fields.total: "1.01" → 1.01 (GET /cart 200: number)',
        '  ~ TC-01 S1 fields.subtotal: "-3" → -3 (GET /cart 200: number)',
      ].join("\n"),
    );
  });

  it("REQ-PLAN-12/AC1: an integer field takes a whole number", () => {
    const { plan: converted } = convertNumericStrings(order({ quantity: "2", total: "80" }), openapi);
    expect(converted.cases[0]?.steps[0]?.expect.fields).toEqual({ quantity: 2, total: 80 });
  });

  it.each([
    ["1,01", "comma"],
    ["$1.01", "currency"],
    ["1.01 PLN", "unit"],
    [" 1.01", "space"],
    ["1e3", "exponent"],
    ["01.5", "leading zero"],
    ["1.", "trailing dot"],
    ["", "empty"],
  ])("REQ-PLAN-12/AC2: %s (%s) stays as written and is still flagged", (value) => {
    const { plan: converted, conversions } = convertNumericStrings(cart({ total: value }), openapi);
    expect(conversions).toEqual([]);
    expect(converted.cases[0]?.steps[0]?.expect.fields).toEqual({ total: value });
  });

  it("REQ-PLAN-12/AC2: a fraction for an integer field, a string field, an unknown field, an unknown call or no OpenAPI are left alone", () => {
    expect(convertNumericStrings(order({ quantity: "2.5" }), openapi).conversions).toEqual([]);
    expect(convertNumericStrings(order({ id: "42" }), openapi).conversions).toEqual([]);
    expect(convertNumericStrings(cart({ total_after: "9.54" }), openapi).conversions).toEqual([]);
    expect(convertNumericStrings(cart({ total: "9.54" }, "GET /nowhere"), openapi).conversions).toEqual([]);
    expect(convertNumericStrings(cart({ total: "9.54" }), undefined).conversions).toEqual([]);
    // A number already is left as it is.
    expect(convertNumericStrings(cart({ total: 9.54 }), openapi).conversions).toEqual([]);
  });

  it("REQ-PLAN-12/AC3: only the type changes; the input plan is not modified", () => {
    const input = cart({ total: "10.50" });
    const { plan: converted } = convertNumericStrings(input, openapi);
    expect(converted.cases[0]?.steps[0]?.expect.fields).toEqual({ total: 10.5 });
    expect(input.cases[0]?.steps[0]?.expect.fields).toEqual({ total: "10.50" });
  });
});
