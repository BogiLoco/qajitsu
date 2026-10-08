// Adversarial suite: the drawing of annotated screenshots (REQ-EVD-08) must not be able to change evidence or a result.
import { PlanSchema } from "@qajitsu/core";
import { createCaseRuntime, createMasker, type UiDriver } from "@qajitsu/steps";
import { describe, expect, it } from "vitest";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-4",
  version: 1,
  summary: "s",
  cases: [
    {
      id: "TC-01",
      title: "Pay",
      type: "web",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "Open",
          expect: { description: "Pay enabled", elements: { "testid:pay": { enabled: true } } },
        },
      ],
      evidence: ["screenshot"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

describe("annotation cannot alter evidence or results (REQ-EVD-08/AC4, invariants 1 and 7)", () => {
  it("REQ-EVD-08/AC4: a drawing function that scribbles over its input changes neither the original screenshot nor the outcome", async () => {
    const shot = new Uint8Array([1, 2, 3, 4]);
    const driver = {
      goto: () => Promise.resolve(),
      url: () => "http://127.0.0.1:3000/",
      screenshot: () => Promise.resolve(shot),
      property: () => Promise.resolve(false),
      bounds: () => Promise.resolve({ x: 0, y: 0, width: 5, height: 5 }),
    } as unknown as UiDriver;
    const runtime = createCaseRuntime({
      plan,
      caseId: "TC-01",
      attempt: 1,
      baseUrl: "http://127.0.0.1:3000",
      transport: () => Promise.reject(new Error("no API")),
      masker: createMasker(),
      allowedOrigins: ["http://127.0.0.1:3000"],
      accounts: {},
      now: () => 0,
      ui: () => Promise.resolve(driver),
      annotate: (png) => {
        png.fill(0); // a buggy or hostile drawing
        return Promise.resolve(png);
      },
    });
    await runtime.context.step("S1", async () => {
      await runtime.context.ui.goto("/");
      runtime.context.verify("S1", "elements.testid:pay.enabled");
    });
    const record = await runtime.finish();
    expect(record.outcome).toBe("failed");
    expect(record.evidence.find((e) => e.name === "S1.png")?.content).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(record.assertions).toEqual([
      expect.objectContaining({
        field: "elements.testid:pay.enabled",
        expected: true,
        actual: false,
        pass: false,
      }),
    ]);
  });
});
