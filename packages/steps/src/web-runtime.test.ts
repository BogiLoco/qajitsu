import { inflateSync } from "node:zlib";
import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, createPlanAccessor, type CaseRuntimeOptions } from "./runtime.js";
import { assertSelector, selectorParts, splitFrames } from "./ui.js";
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

  it("REQ-EXEC-65/AC2+AC3: the browser goes offline and back; the manifest is read by the parent and none never passes", async () => {
    const expect_ = {
      description: "installable",
      manifest: { short_name: "Notes", icons: 1, controlled: true },
    };
    const sw = planWith({ expect: expect_ }, { browser: { service_workers: true } });
    const { driver, calls } = fakeDriver({
      setOffline: (offline: boolean) => Promise.resolve(void calls.push(["setOffline", offline])),
      manifest: () =>
        Promise.resolve({ manifest: { short_name: "Notes", icons: [{ src: "/i.png" }] }, controlled: true }),
    });
    const rt = runtimeFor(sw, driver);
    rt.beginStep("S1");
    await rt.context.ui.goto("/app/notes");
    await rt.context.ui.setOffline(true);
    await rt.context.ui.setOffline(false);
    await expect(rt.uiOp({ op: "setOffline", offline: "yes" as unknown as boolean })).rejects.toThrow(
      "takes true (offline) or false (back online)",
    );
    for (const f of ["manifest.short_name", "manifest.icons", "manifest.controlled"])
      await rt.verify("S1", f);
    expect(calls.filter((c) => c[0] === "setOffline")).toEqual([
      ["setOffline", true],
      ["setOffline", false],
    ]);
    const record = await rt.finish();
    expect(record.assertions.map((a) => [a.field, a.actual, a.pass])).toEqual([
      ["manifest.short_name", "Notes", true],
      ["manifest.icons", 1, true],
      ["manifest.controlled", true, true],
    ]);
    // A page without a manifest fails the check; it is never PASSED.
    const none = runtimeFor(
      sw,
      fakeDriver({ manifest: () => Promise.resolve({ manifest: undefined, controlled: false }) }).driver,
    );
    none.beginStep("S1");
    await none.context.ui.goto("/app/notes");
    await none.verify("S1", "manifest.short_name");
    await none.verify("S1", "manifest.controlled");
    expect((await none.finish()).assertions.map((a) => [a.actual, a.pass])).toEqual([
      ["(the page links no readable web app manifest)", false],
      [false, false],
    ]);
    // Checking the worker of a case that blocks service workers is the plan's mistake: said, not FAILED.
    const blocked = runtimeFor(planWith({ expect: expect_ }), driver);
    blocked.beginStep("S1");
    await blocked.context.ui.goto("/app/notes");
    await expect(blocked.verify("S1", "manifest.controlled")).rejects.toThrow(
      'the case blocks service workers; allow them with "browser": {"service_workers": true}',
    );
    expect(() => createPlanAccessor(sw, "TC-01").expect("TC-01.S1.manifest.colour")).toThrow(
      "unknown manifest field",
    );
  });

  it("REQ-EXEC-67/AC3+AC4: the parent types an account secret; reading it back, screenshots and records show only the mask", async () => {
    const plan = planWith(
      { expect: { description: "d", elements: { "testid:pw": { value: "x" } } } },
      { data: { user: "user:standard" } },
    );
    const typed: unknown[][] = [];
    const shots: unknown[][] = [];
    let fieldValue = "";
    const { driver } = fakeDriver({
      fill: (sel: string, value: string) => {
        typed.push([sel, value]);
        fieldValue = value;
        return Promise.resolve();
      },
      // A lying spec reads the field back through a check: the parent records only the mask.
      property: () => Promise.resolve(fieldValue),
      screenshot: (fullPage: boolean, masks?: readonly string[]) => {
        shots.push([fullPage, [...(masks ?? [])]]);
        return Promise.resolve(new Uint8Array([1]));
      },
      registerSecret: () => undefined,
    });
    const rt = runtimeFor(plan, driver, {
      credential: (alias, field) =>
        alias === "user:standard" && field === "password" ? "S3cret-pass!" : undefined,
    });
    rt.beginStep("S1");
    await rt.context.ui.goto("/app/signin");
    await rt.context.ui.fillSecret("testid:pw", "user:standard", "password");
    await expect(rt.context.ui.fillSecret("testid:pw", "user:admin", "password")).rejects.toThrow(
      "'user:admin' is not an account of TC-01 in the plan",
    );
    await expect(rt.context.ui.fillSecret("testid:pw", "user:standard", "username")).rejects.toThrow(
      "no username for user:standard in this environment",
    );
    await expect(
      rt.uiOp({
        op: "fillSecret",
        selector: "testid:pw",
        alias: "user:standard",
        field: "token" as "password",
      }),
    ).rejects.toThrow('types "password", "username" or "totp"');
    await rt.verify("S1", "elements.testid:pw.value");
    await rt.endStep("S1");
    const record = await rt.finish();
    expect(typed).toEqual([["testid:pw", "S3cret-pass!"]]);
    expect(record.assertions[0]?.actual).toBe("***");
    // The step's screenshot and the failure's full page both black the field out.
    expect(shots).toEqual([
      [false, ["testid:pw"]],
      [true, ["testid:pw"]],
    ]);
    expect(JSON.stringify(record)).not.toContain("S3cret-pass!");
  });

  it("REQ-EXEC-55/AC1+AC3: one-time codes from the authenticator or from the step's message are typed by the parent and masked", async () => {
    const plan = planWith(
      {
        expect: {
          description: "d",
          message: { to: "inbox", subject: "Your code", code: "code: (\\d{6})" },
          elements: { "testid:code": { value: "x" } },
        },
      },
      { data: { user: "user:standard" } },
    );
    const incoming = [
      {
        id: "m1",
        kind: "email" as const,
        receivedAt: new Date(Date.now() + 1000).toISOString(),
        to: "inbox@mail.local",
        subject: "Your code",
        body: "Hello, your code: 482913. It expires in 5 minutes.",
      },
    ];
    let typedValue = "";
    const typed: string[] = [];
    const { driver } = fakeDriver({
      fill: (_sel: string, value: string) => {
        typed.push(value);
        typedValue = value;
        return Promise.resolve();
      },
      property: () => Promise.resolve(typedValue),
      registerSecret: () => undefined,
    });
    const messages = (list: typeof incoming) => ({
      timeoutMs: 50,
      pollMs: 10,
      inbox: () => Promise.resolve({ id: "b", email: "inbox@mail.local", url: "https://hooks.local/b" }),
      capture: {
        createInbox: () => Promise.reject(new Error("unused")),
        deleteInbox: () => Promise.resolve(),
        messages: () => Promise.resolve(list),
      },
    });
    const rt = runtimeFor(plan, driver, {
      messages: messages(incoming),
      credential: (alias, field) => (alias === "user:standard" && field === "totp" ? "123456" : undefined),
    });
    rt.beginStep("S1");
    await rt.context.ui.goto("/app/verify");
    await rt.context.ui.fillSecret("testid:otp", "user:standard", "totp");
    await rt.context.ui.fillCode("testid:code");
    await rt.verify("S1", "elements.testid:code.value");
    await rt.endStep("S1");
    const record = await rt.finish();
    expect(typed).toEqual(["123456", "482913"]);
    expect(record.assertions[0]?.actual).toBe("***");
    expect(JSON.stringify(record)).not.toContain("482913");
    expect(JSON.stringify(record)).not.toContain("123456");
    // The default pattern takes the first 4 to 8 digits; a message without a code is said, never guessed.
    const plain = planWith({ expect: { description: "d", message: { subject: "Your code" } } });
    const codeTyped: string[] = [];
    const codeDriver = fakeDriver({
      registerSecret: () => undefined,
      fill: (_s: string, v: string) => Promise.resolve(void codeTyped.push(v)),
    });
    const withCode = runtimeFor(plain, codeDriver.driver, {
      messages: messages([{ ...incoming[0], body: "Use 7731 to sign in" } as (typeof incoming)[number]]),
    });
    withCode.beginStep("S1");
    await withCode.context.ui.goto("/app/verify");
    await withCode.context.ui.fillCode("testid:code");
    expect(codeTyped).toEqual(["7731"]);
    const noCode = runtimeFor(plain, fakeDriver().driver, {
      messages: messages([{ ...incoming[0], body: "Welcome back" } as (typeof incoming)[number]]),
    });
    noCode.beginStep("S1");
    await noCode.context.ui.goto("/app/verify");
    await expect(noCode.context.ui.fillCode("testid:code")).rejects.toThrow(
      "the message of S1 holds no code matching the plan's pattern",
    );
    // A step whose plan expects no message has nothing to take a code from.
    const noMessage = runtimeFor(
      planWith({ expect: { description: "d", texts: ["x"] } }),
      fakeDriver().driver,
    );
    noMessage.beginStep("S1");
    await noMessage.context.ui.goto("/app/verify");
    await expect(noMessage.context.ui.fillCode("testid:code")).rejects.toThrow(
      "the plan expects no message in S1 to take a code from",
    );
    // No message in time: the planned check of the message fails (FAILED), the code is never guessed.
    const none = runtimeFor(plan, fakeDriver().driver, { messages: messages([]), now: Date.now });
    none.beginStep("S1");
    await none.context.ui.goto("/app/verify");
    await expect(none.context.ui.fillCode("testid:code")).rejects.toThrow(
      "no message with a code arrived in S1",
    );
    const r2 = await none.finish();
    expect(r2.outcome).toBe("failed");
    expect(r2.assertions.map((a) => [a.field, a.actual, a.pass])).toEqual([
      ["message", "(no message arrived in time)", false],
    ]);
  });

  it("REQ-EXEC-47/AC3+AC4: a WebSocket message is looked for by the parent on the planned socket; frames are masked evidence", async () => {
    const plan = planWith({
      expect: {
        description: "d",
        websocket: { url: "/ws/chat", sent: ["hi"], received: ["Support received: hi"] },
      },
    });
    const asked: unknown[][] = [];
    const { driver } = fakeDriver({
      socketFrame: (direction: string, text: string, url: string | undefined, ms: number) => {
        asked.push([direction, text, url, ms]);
        return Promise.resolve(direction === "sent" ? `{"text":"hi"}` : undefined);
      },
      takeSocketFrames: () => [{ url: "shop/ws/chat", direction: "sent", text: `{"text":"hi ${SECRET}"}` }],
    });
    const rt = runtimeFor(plan, driver, { waitTimeoutMs: 1000 });
    rt.beginStep("S1");
    await rt.context.ui.goto("/app/chat");
    await rt.verify("S1", "websocket.sent.0");
    await rt.verify("S1", "websocket.received.0");
    await rt.endStep("S1");
    const record = await rt.finish();
    expect(asked).toEqual([
      ["sent", "hi", "/ws/chat", 1000],
      ["received", "Support received: hi", "/ws/chat", 1000],
    ]);
    expect(record.assertions.map((a) => [a.field, a.actual, a.pass])).toEqual([
      ["websocket.sent.0", "hi", true],
      ["websocket.received.0", "(no received WebSocket message contains it)", false],
    ]);
    expect(String(record.evidence.find((e) => e.name === "S1-websocket.json")?.content)).toContain("hi ***");
    // Without an open page there is nothing to listen to.
    const closed = runtimeFor(plan, fakeDriver().driver);
    closed.beginStep("S1");
    await expect(closed.verify("S1", "websocket.sent.0")).rejects.toThrow("needs an open page");
  });

  it("REQ-EVD-09/AC1+AC2: a failed step gets what went wrong in its traffic; every reached endpoint is recorded", async () => {
    const plan = planWith({ expect: { description: "d", elements: { "testid:total": { text: "10" } } } }, {});
    const batches = [
      [
        { method: "GET", url: "/app/cart", resourceType: "document", sameOrigin: true, status: 200 },
        {
          method: "POST",
          url: `/orders?token=${SECRET}`,
          resourceType: "fetch",
          sameOrigin: true,
          status: 500,
        },
        { method: "GET", url: "/cart", resourceType: "fetch", sameOrigin: true, status: 200 },
      ],
    ];
    const { driver } = fakeDriver({
      property: () => Promise.resolve("9"),
      takeNetwork: () => batches.shift() ?? [],
    });
    const rt = runtimeFor(plan, driver);
    rt.beginStep("S1");
    await rt.context.ui.goto("/app/cart");
    await rt.verify("S1", "elements.testid:total.text");
    await rt.endStep("S1");
    const record = await rt.finish();
    expect(record.steps[0]?.network).toEqual([
      { kind: "server-error", method: "POST", url: "/orders?token=***", status: 500 },
    ]);
    const file = record.evidence.find((e) => e.name === "S1-network.json");
    expect(JSON.parse(String(file?.content))).toEqual({
      requests: 3,
      problems: [{ kind: "server-error", method: "POST", url: "/orders?token=***", status: 500 }],
    });
    expect(record.requests).toEqual([
      { method: "GET", path: "/app/cart", status: 200 },
      { method: "POST", path: "/orders", status: 500 },
      { method: "GET", path: "/cart", status: 200 },
    ]);
    // A step that passed keeps its traffic out of the failure evidence.
    const ok = fakeDriver({
      property: () => Promise.resolve("10"),
      takeNetwork: () => [{ method: "GET", url: "/x", resourceType: "fetch", sameOrigin: true, status: 503 }],
    });
    const passed = runtimeFor(plan, ok.driver);
    passed.beginStep("S1");
    await passed.context.ui.goto("/app/cart");
    await passed.verify("S1", "elements.testid:total.text");
    await passed.endStep("S1");
    const r2 = await passed.finish();
    // INV-1 / REQ-EVD-09/AC7: a 503 the page shrugged off never fails the step; only the planned checks decide.
    expect(r2.outcome).toBe("passed");
    expect(r2.steps[0]?.network).toBeUndefined();
    expect(r2.evidence.some((e) => e.name.endsWith("-network.json"))).toBe(false);
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

describe("dialogs, time and downloads (REQ-EXEC-61)", () => {
  it("REQ-EXEC-61/AC1: the step's dialog answer goes to the driver before each action; dialog.* checks the last dialog; none is a failure", async () => {
    const plan = planWith({
      dialog: { action: "accept", text: "Ada" },
      expect: { description: "d", dialog: { type: "confirm", message: "Delete" } },
    });
    const policies: unknown[] = [];
    let queue: { type: string; message: string; answer: string }[] = [];
    const { driver } = fakeDriver({
      setDialogPolicy: (p: unknown) => {
        policies.push(p);
      },
      takeDialogs: () => queue.splice(0),
    });
    const rt = runtimeFor(plan, driver);
    rt.beginStep("S1");
    await rt.uiOp({ op: "goto", path: "/a" });
    await rt.verify("S1", "dialog.type");
    queue = [
      { type: "alert", message: "Saved", answer: "accepted" },
      { type: "confirm", message: `Delete ${SECRET}?`, answer: "accepted with text" },
    ];
    await rt.verify("S1", "dialog.type");
    await rt.verify("S1", "dialog.message");
    queue = [{ type: "prompt", message: "Name?", answer: "dismissed" }];
    await rt.endStep("S1");
    const record = await rt.finish();
    expect(policies).toEqual([{ action: "accept", text: "Ada" }]);
    expect(record.assertions.map((a) => [a.field, a.actual, a.pass])).toEqual([
      ["dialog.type", "(no dialog in this step)", false],
      ["dialog.type", "confirm", true],
      ["dialog.message", "Delete ***?", true],
    ]);
    const log = String(record.evidence.find((e) => e.name === "S1-dialogs.json")?.content);
    expect(log).toContain('"Name?"');
    expect(log).not.toContain(SECRET);
  });

  it("REQ-EXEC-61/AC2+AC4: time moves by whole seconds up to 7 days; download.count counts the step's downloads", async () => {
    const plan = planWith({ expect: { description: "d", download: { count: 2 } } });
    const { driver, calls } = fakeDriver({
      advanceTime: (ms: number) => Promise.resolve(void calls.push(["advanceTime", ms])),
    });
    const rt = runtimeFor(plan, driver);
    rt.beginStep("S1");
    await rt.context.ui.advanceTime(90);
    await expect(rt.context.ui.advanceTime(0)).rejects.toThrow("whole seconds from 1 to 604800");
    await expect(rt.context.ui.advanceTime(1.5)).rejects.toThrow("whole seconds");
    await expect(rt.context.ui.advanceTime(604_801)).rejects.toThrow("7 days");
    await rt.uiOp({ op: "download", selector: "testid:a" });
    await rt.uiOp({ op: "download", selector: "testid:a" });
    await rt.verify("S1", "download.count");
    expect(calls).toContainEqual(["advanceTime", 90_000]);
    expect((await rt.finish()).assertions[0]).toMatchObject({
      field: "download.count",
      actual: 2,
      pass: true,
    });
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
    // REQ-EXEC-64: an element inside an element is a chain now.
    expect(assertSelector("testid:a >> testid:b")).toBe("testid:a >> testid:b");
    expect(() => assertSelector(`${"frame:css:f >> ".repeat(8)}testid:a`)).toThrow("Invalid selector");
    expect(() => assertSelector("frame:title:Pay >> ")).toThrow("Invalid selector");
  });

  it("REQ-EXEC-64/AC1+AC2+AC3: chains of elements and filters are parsed and validated; several matches say how to narrow", async () => {
    expect(
      selectorParts("frame:title:Pay >> role:row >> has-text:Anna Smith >> role:button:Delete >> nth:2"),
    ).toEqual([
      { kind: "frame", selector: "title:Pay" },
      { kind: "element", selector: "role:row" },
      { kind: "hasText", text: "Anna Smith" },
      { kind: "element", selector: "role:button:Delete" },
      { kind: "nth", n: 2 },
    ]);
    expect(assertSelector("testid:card >> nth:2")).toBe("testid:card >> nth:2");
    for (const bad of [
      "has-text:Anna",
      "nth:2",
      "frame:title:Pay >> nth:1",
      "testid:a >> nth:0",
      "testid:a >> frame:title:x",
      `${"testid:a >> ".repeat(8)}testid:b`,
    ])
      expect(() => assertSelector(bad), bad).toThrow("Invalid selector");
    const { driver } = fakeDriver({
      click: () =>
        Promise.reject(
          new Error("strict mode violation: getByRole('button', { name: 'Delete' }) resolved to 3 elements"),
        ),
    });
    const rt = runtimeFor(planWith({ expect: { description: "d" } }), driver);
    rt.beginStep("S1");
    await expect(rt.uiOp({ op: "click", selector: "role:button:Delete" })).rejects.toThrow(
      "the selector matches 3 elements: narrow it with ' >> has-text:<text>', ' >> nth:<n>' or a parent element first",
    );
  });

  it("REQ-EXEC-05: an action on the empty page says that no page is open", async () => {
    const { driver } = fakeDriver({
      url: () => "about:blank",
      click: () => Promise.reject(new Error("locator.click: Timeout 5000ms exceeded")),
    });
    const rt = runtimeFor(planWith({ expect: { description: "d" } }), driver);
    rt.beginStep("S1");
    await expect(rt.uiOp({ op: "click", selector: "testid:delete-1" })).rejects.toThrow(
      'no page is open: call ui.goto("<path>") before ui.click()',
    );
  });
});
