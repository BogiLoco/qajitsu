import { inflateSync } from "node:zlib";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, createPlanAccessor, type CaseRuntimeOptions } from "./runtime.js";
import { assertSelector, splitFrames } from "./ui.js";
import type { UiDriver, UiFile } from "./ui.js";
import { csvRows, generateFile, isTextType, mimeOf } from "./web-files.js";

const SECRET = "fictional-secret-value-123";

/** A plan with one web case whose single step expects what the test passes. */
const planWith = (step: Record<string, unknown>, extra: Record<string, unknown> = {}, type = "web") =>
  PlanSchema.parse({
    schema: 1,
    ticket: "DEMO-7",
    version: 1,
    cases: [
      {
        id: "TC-01",
        title: "web gaps",
        type,
        priority: "high",
        source: [{ kind: "ac", id: "AC1" }],
        ...extra,
        steps: [{ id: "S1", action: "do it", ...step }],
        evidence: ["screenshot"],
      },
    ],
  });

/** A driver that records calls; `with` replaces or removes methods. */
const fakeDriver = (overrides: Partial<Record<keyof UiDriver, unknown>> = {}) => {
  const calls: unknown[][] = [];
  const rec =
    (name: string, result?: unknown) =>
    (...args: unknown[]) => {
      calls.push([name, ...args]);
      return Promise.resolve(result);
    };
  const d: Record<string, unknown> = {
    goto: rec("goto"),
    screenshot: () => Promise.resolve(new Uint8Array([1])),
    url: () => "http://127.0.0.1:3000/app",
    dom: () => Promise.resolve(""),
    pageText: () => Promise.resolve(""),
    property: rec("property", true),
    pointer: rec("pointer"),
    dragTo: rec("dragTo"),
    dragBy: rec("dragBy"),
    keys: rec("keys"),
    scrollTo: rec("scrollTo"),
    scrollBy: rec("scrollBy"),
    scrollUntil: rec("scrollUntil", { scrolls: 3, found: false, y: 900 }),
    upload: rec("upload"),
    download: rec("download", {
      name: "orders.csv",
      data: new TextEncoder().encode(`id,total\nO-1,${SECRET}\nO-2,5\n`),
    }),
    switchPage: rec("switchPage", { index: 1, url: "http://127.0.0.1:3000/3ds" }),
    closePage: rec("closePage", { index: 0, url: "http://127.0.0.1:3000/app" }),
    currentPage: () => ({ index: 1, url: "http://127.0.0.1:3000/3ds" }),
    testState: rec("testState", { hook: true, value: 6 }),
    elementScreenshot: rec("elementScreenshot", new Uint8Array([9])),
    ...overrides,
  };
  const driver = Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined));
  return { driver: driver as unknown as UiDriver, calls };
};

const runtimeFor = (
  plan: ReturnType<typeof planWith>,
  driver: UiDriver,
  options: Partial<CaseRuntimeOptions> = {},
) =>
  createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.resolve({ status: 200, headers: {}, text: "{}" }),
    masker: createMasker({ secrets: [SECRET] }),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => 0,
    ui: () => Promise.resolve(driver),
    ...options,
  });

describe("web actions in the trusted runtime (REQ-EXEC-38..40, REQ-EXEC-56, ADR-0013)", () => {
  it("REQ-EXEC-38/AC1+AC3: uploads resolve the plan's files (generated or fixtures), are evidence, and refuse anything else", async () => {
    const plan = planWith(
      { expect: { description: "d" } },
      {
        files: {
          avatar: { name: "a.png", type: "image/png", bytes: 120 },
          notes: { fixture: "docs/notes.txt" },
          scan: { fixture: "docs/scan.pdf" },
        },
      },
    );
    const { driver, calls } = fakeDriver();
    const fixtures: string[] = [];
    const rt = runtimeFor(plan, driver, {
      fixture: (path) => {
        fixtures.push(path);
        return Promise.resolve(new TextEncoder().encode(path.endsWith(".txt") ? `token ${SECRET}` : "%PDF"));
      },
      extractText: (name) => Promise.resolve(name.endsWith(".pdf") ? `page text ${SECRET}` : undefined),
    });
    rt.beginStep("S1");
    await rt.uiOp({ op: "upload", selector: "testid:avatar-input", files: ["avatar", "notes", "scan"] });
    const uploaded = calls.find((c) => c[0] === "upload")?.[2] as UiFile[];
    expect(uploaded.map((f) => [f.name, f.type, f.data.length])).toEqual([
      ["a.png", "image/png", 120],
      ["notes.txt", "text/plain", 32],
      ["scan.pdf", "application/pdf", 4],
    ]);
    expect(fixtures).toEqual(["docs/notes.txt", "docs/scan.pdf"]);
    await expect(rt.uiOp({ op: "upload", selector: "testid:x", files: ["../etc/passwd"] })).rejects.toThrow(
      "'../etc/passwd' is not a file of TC-01 in the plan",
    );
    await expect(rt.uiOp({ op: "upload", selector: "testid:x", files: [] })).rejects.toThrow(
      "at least one file key",
    );
    await rt.endStep("S1");
    const record = await rt.finish();
    const evidence = record.evidence.filter((e) => e.kind === "upload");
    expect(evidence.map((e) => e.name)).toEqual([
      "S1-upload-a.png",
      "S1-upload-notes.txt",
      "S1-upload-scan.pdf.masked.txt",
    ]);
    // AC3: text is masked; a binary file whose text holds a secret is kept as its masked text only.
    for (const e of evidence) expect(Buffer.from(e.content).toString("utf8")).not.toContain(SECRET);
    const noFixtures = runtimeFor(plan, driver);
    noFixtures.beginStep("S1");
    await expect(noFixtures.uiOp({ op: "upload", selector: "testid:x", files: ["notes"] })).rejects.toThrow(
      "This run has no fixtures",
    );
  });

  it("REQ-EXEC-38/AC2+AC4: a download is checked by code; no download fails, unreadable content is not a pass", async () => {
    const plan = planWith({
      expect: {
        description: "d",
        download: {
          name: "orders.csv",
          type: "csv",
          min_bytes: 10,
          max_bytes: 1000,
          rows: 2,
          texts: ["O-2,5"],
          sha256: "0".repeat(64),
        },
      },
    });
    const { driver } = fakeDriver();
    const rt = runtimeFor(plan, driver);
    rt.beginStep("S1");
    // Before the download: nothing to check yet, which fails, never passes.
    await rt.verify("S1", "download.name");
    await rt.uiOp({ op: "download", selector: "testid:export" });
    for (const f of ["name", "type", "size", "rows", "texts.0", "sha256"])
      await rt.verify("S1", `download.${f}`);
    await rt.endStep("S1");
    const record = await rt.finish();
    expect(record.assertions.map((a) => [a.field, a.pass])).toEqual([
      ["download.name", false],
      ["download.name", true],
      ["download.type", true],
      ["download.size", true],
      ["download.rows", true],
      ["download.texts.0", true],
      ["download.sha256", false],
    ]);
    expect(record.assertions[0]?.actual).toBe("(no download in this step)");
    const file = record.evidence.find((e) => e.kind === "download");
    expect(String(file?.content)).not.toContain(SECRET);

    // A type given as MIME, JSON fields, and content that cannot be read.
    const json = planWith({
      expect: {
        description: "d",
        download: { type: "application/json", fields: { "items.0.id": "A" }, texts: ["x"] },
      },
    });
    const jsonDriver = fakeDriver({
      download: () =>
        Promise.resolve({ name: "data.json", data: new TextEncoder().encode('{"items":[{"id":"A"}]}') }),
    });
    const j = runtimeFor(json, jsonDriver.driver);
    j.beginStep("S1");
    await j.uiOp({ op: "download", selector: "testid:export" });
    await j.verify("S1", "download.type");
    await j.verify("S1", "download.fields.items.0.id");
    expect((await j.finish()).assertions.map((a) => a.pass)).toEqual([true, true]);
    const binary = fakeDriver({
      download: () => Promise.resolve({ name: "report.pdf", data: new Uint8Array([1, 2]) }),
    });
    const b = runtimeFor(json, binary.driver);
    b.beginStep("S1");
    await b.uiOp({ op: "download", selector: "testid:export" });
    await expect(b.verify("S1", "download.texts.0")).rejects.toThrow(
      "the content of report.pdf cannot be read",
    );
    await expect(b.verify("S1", "download.fields.items.0.id")).rejects.toThrow("cannot be read");
    const notJson = fakeDriver({
      download: () => Promise.resolve({ name: "data.txt", data: new TextEncoder().encode("{") }),
    });
    const n = runtimeFor(json, notJson.driver);
    n.beginStep("S1");
    await n.uiOp({ op: "download", selector: "testid:export" });
    await expect(n.verify("S1", "download.fields.items.0.id")).rejects.toThrow("data.txt is not JSON");
  });

  it("REQ-EXEC-40/AC1+AC2+AC3: pointer, drag, keys and scroll go to the driver; scrollUntil uses the step's limit and records the result", async () => {
    const plan = planWith({
      scroll_limit: 7,
      expect: { description: "d", elements: { "testid:row": { in_viewport: true } } },
    });
    const { driver, calls } = fakeDriver();
    const rt = runtimeFor(plan, driver);
    rt.beginStep("S1");
    await rt.context.ui.hover("testid:a");
    await rt.context.ui.dblclick("testid:a");
    await rt.context.ui.rightClick("testid:a");
    await rt.context.ui.dragTo("testid:a", "testid:b");
    await rt.context.ui.dragBy("testid:a", 5, -5);
    await rt.context.ui.keys("Escape");
    await rt.context.ui.scrollTo("testid:a");
    await rt.context.ui.scrollBy(0, 300);
    await rt.context.ui.scrollUntil("testid:row");
    await rt.verify("S1", "elements.testid:row.in_viewport");
    await rt.endStep("S1");
    expect(calls.filter((c) => c[0] !== "property")).toEqual([
      ["pointer", "testid:a", "hover"],
      ["pointer", "testid:a", "dblclick"],
      ["pointer", "testid:a", "rightclick"],
      ["dragTo", "testid:a", "testid:b"],
      ["dragBy", "testid:a", 5, -5],
      ["keys", "Escape"],
      ["scrollTo", "testid:a"],
      ["scrollBy", 0, 300],
      ["scrollUntil", "testid:row", 7],
    ]);
    expect(calls).toContainEqual(["property", "testid:row", "in_viewport"]);
    const record = await rt.finish();
    const log = JSON.parse(
      String(record.evidence.find((e) => e.name === "ui-actions.json")?.content),
    ) as Record<string, unknown>[];
    expect(log.find((a) => a["op"] === "scrollUntil.result")).toEqual({
      stepId: "S1",
      op: "scrollUntil.result",
      scrolls: 3,
      found: false,
      y: 900,
      limit: 7,
    });
    // REQ-EXEC-39/AC2: every action names its page.
    expect(log.find((a) => a["op"] === "hover")).toMatchObject({ page: 1, url: "http://127.0.0.1:3000/3ds" });
  });

  it("REQ-EXEC-39/AC2: pop-ups and tabs go to the driver with the wait time", async () => {
    const { driver, calls } = fakeDriver();
    const rt = runtimeFor(planWith({ expect: { description: "d" } }), driver, { waitTimeoutMs: 1234 });
    rt.beginStep("S1");
    await rt.context.ui.switchToNewPage();
    await rt.context.ui.switchToOpener();
    await rt.context.ui.closePage();
    expect(calls).toEqual([["switchPage", "new", 1234], ["switchPage", "opener", 1234], ["closePage"]]);
  });

  it("REQ-EXEC-56/AC1+AC2: test state from the page's hook, an element-scoped visual check, and why an element is unreachable", async () => {
    const plan = planWith({
      expect: {
        description: "d",
        state: { "bars.3.value": 6 },
        visual: { name: "chart", element: "testid:chart" },
      },
    });
    const { driver, calls } = fakeDriver({
      click: () => Promise.reject(new Error("timeout waiting for testid:reveal")),
      unreachableReason: () => Promise.resolve("the page has closed shadow roots (in x-legacy)"),
    });
    const baselines: string[] = [];
    const rt = runtimeFor(plan, driver, {
      testStateHook: "__APP_TEST__",
      visual: {
        variant: "chromium",
        threshold: 0,
        baseline: (key) => {
          baselines.push(key);
          return Promise.resolve(undefined);
        },
        compare: () => Promise.reject(new Error("not reached")),
      },
    });
    rt.beginStep("S1");
    await rt.uiOp({ op: "goto", path: "/app" });
    await rt.verify("S1", "state.bars.3.value");
    await rt.verify("S1", "visual");
    expect(calls).toContainEqual(["testState", "__APP_TEST__", "bars.3.value"]);
    expect(calls).toContainEqual(["elementScreenshot", "testid:chart"]);
    expect(baselines).toEqual(["TC-01/S1-chart.chromium"]);
    await expect(rt.uiOp({ op: "click", selector: "testid:reveal" })).rejects.toThrow(
      "timeout waiting for testid:reveal; the page has closed shadow roots (in x-legacy)",
    );
    const record = await rt.finish();
    expect(record.assertions[0]).toMatchObject({ field: "state.bars.3.value", actual: 6, pass: true });
    // A page without the hook is not a pass and not a fail of the product: it says so.
    const noHook = fakeDriver({ testState: () => Promise.resolve({ hook: false, value: undefined }) });
    const r2 = runtimeFor(plan, noHook.driver);
    r2.beginStep("S1");
    await r2.uiOp({ op: "goto", path: "/app" });
    await expect(r2.verify("S1", "state.bars.3.value")).rejects.toThrow(
      "the page has no test hook window.__QA_STATE__",
    );
    const closed = runtimeFor(plan, fakeDriver().driver);
    closed.beginStep("S1");
    await expect(closed.verify("S1", "state.bars.3.value")).rejects.toThrow("needs an open page");
  });

  it("REQ-EXEC-38..40 + ADR-0013: a driver without a web action refuses it with the reason, on mobile as not available yet", async () => {
    const without = fakeDriver({ pointer: undefined, download: undefined, switchPage: undefined });
    const web = runtimeFor(planWith({ expect: { description: "d" } }), without.driver);
    web.beginStep("S1");
    await expect(web.context.ui.hover("testid:a")).rejects.toThrow(
      "ui.hover() is not available in this runner",
    );
    await expect(web.context.ui.rightClick("testid:a")).rejects.toThrow("ui.rightClick() is not available");
    await expect(web.context.ui.download("testid:a")).rejects.toThrow("ui.download() is not available");
    const mobile = runtimeFor(planWith({ expect: { description: "d" } }, {}, "mobile"), without.driver);
    mobile.beginStep("S1");
    await expect(mobile.context.ui.switchToNewPage()).rejects.toThrow("is not available in native apps yet");
  });
});

describe("files of web cases (REQ-EXEC-38)", () => {
  it("types by name, text types, generated files and CSV rows", () => {
    expect(mimeOf("a.PNG")).toBe("image/png");
    expect(mimeOf("report.xlsx")).toContain("spreadsheetml");
    expect(mimeOf("noext")).toBe("application/octet-stream");
    expect(isTextType("text/csv")).toBe(true);
    expect(isTextType("image/svg+xml")).toBe(true);
    expect(isTextType("application/pdf")).toBe(false);
    const png = generateFile({ name: "a.png", type: "image/png", bytes: 5000 });
    expect(png.length).toBe(5000);
    expect(Buffer.from(png.subarray(1, 4)).toString("ascii")).toBe("PNG");
    // The image data is a real zlib stream of one pixel row.
    const idat = Buffer.from(png).indexOf("IDAT");
    expect(inflateSync(Buffer.from(png.subarray(idat + 4, idat + 4 + 16)))).toEqual(Buffer.alloc(5));
    expect(generateFile({ name: "s.png", type: "image/png", bytes: 10 }).length).toBeGreaterThan(10);
    expect(new TextDecoder().decode(generateFile({ name: "n.txt", type: "text/plain", bytes: 30 }))).toBe(
      "QAJitsu test file n.txt\nQAJits",
    );
    expect(generateFile({ name: "b.bin", type: "application/zip", bytes: 3 })).toEqual(
      new Uint8Array([0x71, 0x71, 0x71]),
    );
    expect(csvRows("a,b\n1,2\n3,4\n")).toBe(2);
    expect(csvRows('a,b\r\n"x\ny",2\r\n\r\n3,4')).toBe(2);
    expect(csvRows("")).toBe(0);
  });

  it("REQ-EXEC-38/AC2 + REQ-EXEC-56/AC2: plan.expect reads download and state expectations and refuses what the plan does not say", () => {
    const plan = planWith({
      expect: {
        description: "d",
        download: { name: "a.csv", texts: ["x"], fields: { k: 1 } },
        state: { "a.b": 2 },
      },
    });
    const accessor = createPlanAccessor(plan, "TC-01");
    expect(accessor.expect("TC-01.S1.download.name")).toBe("a.csv");
    expect(accessor.expect("TC-01.S1.download.texts.0")).toBe("x");
    expect(accessor.expect("TC-01.S1.download.fields.k")).toBe(1);
    expect(accessor.expect("TC-01.S1.state.a.b")).toBe(2);
    expect(() => accessor.expect("TC-01.S1.download.size")).toThrow("no expected value");
    expect(() => accessor.expect("TC-01.S1.download.bogus")).toThrow("unknown download field");
    expect(() => accessor.expect("TC-01.S1.state.other")).toThrow("no expected state 'other'");
  });

  it("REQ-EXEC-40/AC2 + REQ-EXEC-38/AC2: scrollUntil without a step limit scrolls at most 20 times; text missing from a file is not a pass", async () => {
    const plan = planWith({ expect: { description: "d", download: { texts: ["missing"] } } });
    const { driver, calls } = fakeDriver({
      download: () => Promise.resolve({ name: "a b?.txt", data: new TextEncoder().encode("abc") }),
    });
    const rt = runtimeFor(plan, driver);
    rt.beginStep("S1");
    await rt.context.ui.scrollUntil("testid:row");
    await rt.uiOp({ op: "download", selector: "testid:export" });
    await rt.verify("S1", "download.texts.0");
    expect(calls).toContainEqual(["scrollUntil", "testid:row", 20]);
    const record = await rt.finish();
    expect(record.assertions[0]).toMatchObject({ actual: "(text not in the file)", pass: false });
    // A download's name is made safe for a file name.
    expect(record.evidence.find((e) => e.kind === "download")?.name).toBe("S1-download-a_b_.txt");
  });

  it("REQ-EXEC-39/AC1: selectors inside frames are validated and split; anything else in a chain is refused", () => {
    expect(assertSelector("frame:title:Pay >> frame:css:iframe#x >> testid:card")).toBe(
      "frame:title:Pay >> frame:css:iframe#x >> testid:card",
    );
    expect(splitFrames("frame:title:Pay >> frame:css:iframe#x >> testid:card")).toEqual({
      frames: ["title:Pay", "css:iframe#x"],
      element: "testid:card",
    });
    expect(splitFrames("testid:a")).toEqual({ frames: [], element: "testid:a" });
    expect(() => assertSelector("frame:role:x >> testid:a")).toThrow("Invalid selector");
    expect(() => assertSelector("testid:a >> testid:b")).toThrow("Invalid selector");
    expect(() => assertSelector(`${"frame:css:f >> ".repeat(6)}testid:a`)).toThrow("Invalid selector");
    expect(() => assertSelector("frame:title:Pay >> ")).toThrow("Invalid selector");
  });
});
