import { PlanSchema, type ImageComparison, type ScreenMark } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime } from "./runtime.js";
import type { UiDriver } from "./ui.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-4",
  version: 1,
  summary: "Checkout",
  cases: [
    {
      id: "TC-01",
      title: "Pay button",
      type: "web",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "Open the checkout",
          expect: {
            description: "Pay is enabled, the hint is shown",
            elements: { "testid:pay": { enabled: true, text: "Pay now" }, "testid:hint": { visible: true } },
            visual: { name: "checkout" },
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
const BASE = new Uint8Array([7, 7, 7]);

const setup = (
  opts: {
    enabled?: boolean;
    hintShown?: boolean;
    compare?: ImageComparison;
    baseline?: Uint8Array | undefined;
    annotate?: (png: Uint8Array, marks: readonly ScreenMark[]) => Promise<Uint8Array>;
    noBounds?: boolean;
  } = {},
) => {
  const drawn: { png: Uint8Array; marks: readonly ScreenMark[] }[] = [];
  const driver = {
    goto: () => Promise.resolve(),
    url: () => "http://127.0.0.1:3000/checkout",
    screenshot: () => Promise.resolve(SHOT),
    property: (selector: string, property: string) =>
      Promise.resolve(
        selector === "testid:pay"
          ? property === "enabled"
            ? (opts.enabled ?? true)
            : "Pay now"
          : (opts.hintShown ?? true),
      ),
    ...(opts.noBounds
      ? {}
      : {
          bounds: (selector: string) =>
            selector === "testid:pay"
              ? Promise.resolve({ x: 10, y: 20, width: 80, height: 30 })
              : selector === "testid:hint"
                ? Promise.reject(new Error("detached"))
                : Promise.resolve(undefined),
        }),
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
    annotate:
      opts.annotate ??
      ((png, marks) => {
        drawn.push({ png, marks });
        return Promise.resolve(new Uint8Array([9, ...png]));
      }),
    visual: {
      variant: "chromium-desktop",
      threshold: 0.01,
      baseline: () => Promise.resolve("baseline" in opts ? opts.baseline : BASE),
      compare: () =>
        Promise.resolve(opts.compare ?? { width: 10, height: 10, diffPixels: 0, diff: new Uint8Array([5]) }),
    },
  });
  const play = async () => {
    let error: unknown;
    try {
      await runtime.context.step("S1", async () => {
        await runtime.context.ui.goto("/checkout");
        runtime.context.verify("S1", "elements.testid:pay.enabled");
        runtime.context.verify("S1", "elements.testid:pay.text");
        runtime.context.verify("S1", "elements.testid:hint.visible");
        runtime.context.verify("S1", "visual");
      });
    } catch (e) {
      error = e;
    }
    return runtime.finish(error);
  };
  return { play, drawn };
};

const named = (record: { evidence: readonly { name: string; content: unknown }[] }, name: string) =>
  record.evidence.find((e) => e.name === name);
const marksOf = (record: { evidence: readonly { name: string; content: unknown }[] }) =>
  (
    JSON.parse(
      (() => {
        const c = named(record, "S1-annotations.json")?.content;
        return typeof c === "string" ? c : "{}";
      })(),
    ) as { marks?: unknown[] }
  ).marks;

describe("annotated failure screenshots (REQ-EVD-08)", () => {
  it("REQ-EVD-08/AC1+AC4: a failed element assertion gets a numbered box on a copy, with field, expected and actual", async () => {
    const { play, drawn } = setup({ enabled: false });
    const record = await play();
    expect(record.outcome).toBe("failed");
    expect(drawn).toEqual([{ png: SHOT, marks: [{ n: 1, box: { x: 10, y: 20, width: 80, height: 30 } }] }]);
    expect(named(record, "S1.png")?.content).toEqual(SHOT);
    expect(named(record, "S1-annotated.png")).toMatchObject({
      kind: "screenshot",
      content: new Uint8Array([9, 1, 2, 3]),
    });
    expect(marksOf(record)).toEqual([
      {
        n: 1,
        field: "elements.testid:pay.enabled",
        expected: true,
        actual: false,
        box: { x: 10, y: 20, width: 80, height: 30 },
      },
    ]);
    // The annotation changes no assertion: the same one failed, the passing one still passes.
    expect(record.assertions.map((a) => [a.field, a.pass])).toEqual([
      ["elements.testid:pay.enabled", false],
      ["elements.testid:pay.text", true],
      ["elements.testid:hint.visible", true],
      ["visual", true],
    ]);
  });

  it("REQ-EVD-08/AC2: a missing element gets a note and no box; without a visual failure no picture is drawn", async () => {
    const { play, drawn } = setup({ hintShown: false });
    const record = await play();
    expect(drawn).toEqual([]);
    expect(named(record, "S1-annotated.png")).toBeUndefined();
    expect(marksOf(record)).toEqual([
      {
        n: 1,
        field: "elements.testid:hint.visible",
        expected: true,
        actual: false,
        note: "element not found on the screen",
      },
    ]);
  });

  it("REQ-EVD-08/AC2+AC3: with a visual failure the changed regions are boxed, also on a copy of the baseline", async () => {
    const regions = [
      { x: 5, y: 5, width: 20, height: 10 },
      { x: 60, y: 40, width: 20, height: 10 },
    ];
    const { play, drawn } = setup({
      hintShown: false,
      compare: { width: 10, height: 10, diffPixels: 50, diff: new Uint8Array([5]), regions },
    });
    const record = await play();
    expect(drawn.map((d) => d.png)).toEqual([SHOT, BASE]);
    expect(drawn[0]?.marks).toEqual([
      { n: 2, box: regions[0] },
      { n: 3, box: regions[1] },
    ]);
    expect(drawn[1]?.marks).toEqual(drawn[0]?.marks);
    expect(named(record, "S1-annotated-baseline.png")).toBeDefined();
    expect(marksOf(record)).toHaveLength(3);
  });

  it("REQ-EVD-08/AC3: a visual failure without regions or a driver without bounds still records the notes", async () => {
    const { play, drawn } = setup({
      enabled: false,
      noBounds: true,
      compare: { width: 10, height: 10, diffPixels: 50, diff: new Uint8Array([5]) },
    });
    const record = await play();
    expect(drawn).toEqual([]);
    expect(marksOf(record)).toEqual([
      expect.objectContaining({ n: 1, note: "element not found on the screen" }),
    ]);
  });

  it("REQ-EVD-08/AC4: a passing step gets no annotation; a drawing that fails leaves the evidence and result as they are", async () => {
    const clean = await setup().play();
    expect(clean.outcome).toBe("passed");
    expect(clean.evidence.some((e) => e.name.includes("annotat"))).toBe(false);
    const broken = await setup({
      enabled: false,
      annotate: () => Promise.reject(new Error("bad png")),
    }).play();
    expect(broken.outcome).toBe("failed");
    expect(broken.error).toBeUndefined();
    expect(named(broken, "S1.png")?.content).toEqual(SHOT);
    expect(broken.evidence.some((e) => e.name.includes("annotat"))).toBe(false);
  });
});
