import { PlanSchema, type ImageComparison } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime } from "./runtime.js";
import type { UiDriver } from "./ui.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-4",
  version: 1,
  summary: "Checkout looks right",
  cases: [
    {
      id: "TC-01",
      title: "Checkout page layout",
      type: "web",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "Open the checkout",
          expect: {
            description: "Looks like the approved design",
            visual: { name: "checkout", mask: ["testid:date"] },
          },
        },
      ],
      evidence: ["screenshot"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const SHOT = new Uint8Array([1, 2, 3]);
const setup = (
  opts: { baseline?: Uint8Array; compare?: ImageComparison; threshold?: number; noVisual?: boolean } = {},
) => {
  const masksSeen: unknown[] = [];
  const driver = {
    goto: () => Promise.resolve(),
    url: () => "http://127.0.0.1:3000/checkout",
    screenshot: (_full: boolean, masks?: readonly unknown[]) => {
      masksSeen.push(masks);
      return Promise.resolve(SHOT);
    },
  } as unknown as UiDriver;
  const keys: string[] = [];
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
    ...(opts.noVisual
      ? {}
      : {
          visual: {
            variant: "chromium-desktop",
            threshold: opts.threshold ?? 0.01,
            baseline: (key: string) => {
              keys.push(key);
              return Promise.resolve(opts.baseline);
            },
            compare: () =>
              Promise.resolve(
                opts.compare ?? { width: 10, height: 10, diffPixels: 0, diff: new Uint8Array([9]) },
              ),
          },
        }),
  });
  const play = async () => {
    let error: unknown;
    try {
      await runtime.context.step("S1", async () => {
        await runtime.context.ui.goto("/checkout");
        runtime.context.verify("S1", "visual");
      });
    } catch (e) {
      error = e;
    }
    return runtime.finish(error);
  };
  return { play, keys, masksSeen };
};

describe("visual regression in steps (REQ-EXEC-12)", () => {
  it("REQ-EXEC-12/AC3: without a baseline the screenshot is proposed and the assertion waits for a person", async () => {
    const { play, keys, masksSeen } = setup();
    const record = await play();
    expect(keys).toEqual(["TC-01/S1-checkout.chromium-desktop"]);
    expect(masksSeen).toContainEqual(["testid:date"]);
    expect(record.assertions).toEqual([
      expect.objectContaining({
        field: "visual",
        pass: true,
        review: true,
        actual: "(no baseline yet: this screenshot is proposed)",
      }),
    ]);
    expect(record.evidence.map((e) => e.name)).toContain("S1-visual-actual.png");
  });

  it("REQ-EXEC-12/AC2: a difference above the threshold fails, with baseline, screenshot and diff as evidence", async () => {
    const record = await setup({
      baseline: new Uint8Array([7]),
      compare: { width: 10, height: 10, diffPixels: 5, diff: new Uint8Array([9]) },
    }).play();
    expect(record.outcome).toBe("failed");
    expect(record.assertions[0]).toMatchObject({ pass: false, actual: { diffPixels: 5, ratio: 0.05 } });
    expect(record.evidence.map((e) => e.name)).toEqual(
      expect.arrayContaining(["S1-visual-actual.png", "S1-visual-baseline.png", "S1-visual-diff.png"]),
    );
  });

  it("REQ-EXEC-12/AC1+AC2: within the threshold passes; a size change fails; no visual check or no browser is an error", async () => {
    const within = await setup({
      baseline: new Uint8Array([7]),
      compare: { width: 10, height: 10, diffPixels: 1, diff: new Uint8Array() },
      threshold: 0.02,
    }).play();
    expect(within.assertions[0]).toMatchObject({ pass: true });
    expect(within.assertions[0]).not.toHaveProperty("review");
    const resized = await setup({
      baseline: new Uint8Array([7]),
      compare: { sizeMismatch: "baseline is 10×10, the screenshot 12×10" },
    }).play();
    expect(resized.assertions[0]).toMatchObject({
      pass: false,
      actual: "baseline is 10×10, the screenshot 12×10",
    });
    const none = await setup({ noVisual: true }).play();
    expect(none.outcome).toBe("error");
    expect(none.error).toContain("no visual comparison");
  });
});
