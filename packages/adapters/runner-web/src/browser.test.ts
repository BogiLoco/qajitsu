import { readFileSync } from "node:fs";
import { mkdtemp, rm as remove, writeFile as write } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import { computeStatus } from "@qajitsu/verifier";
import { fileURLToPath } from "node:url";
import {
  createPlaywrightTransport,
  executeAttempt,
  runCases,
  type AttemptInput,
} from "@qajitsu/adapter-runner-api";
import { PlanSchema, createEventLog, unzip, zip } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import {
  browserUnavailable,
  channelExecutables,
  createPlaywrightBrowserFactory,
  maskHar,
  maskTrace,
} from "./browser.js";

const PASSWORD = "fictional-demo-password";
const plan = (ticket: string) =>
  PlanSchema.parse({
    schema: 1,
    ticket,
    version: 1,
    ...JSON.parse(
      readFileSync(
        new URL(`../../../../fixtures/plans/${ticket.toLowerCase()}-draft.json`, import.meta.url),
        "utf8",
      ),
    ),
  });
const spec = (ticket: string, id: string) =>
  fileURLToPath(new URL(`../../../../fixtures/specs/${ticket.toLowerCase()}/${id}.spec.ts`, import.meta.url));

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const attempt = async (
  ticket: string,
  caseId: string,
  flag?: string,
  video: "retain-on-failure" | "always" | "off" = "retain-on-failure",
) => {
  const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) } });
  cleanups.push(() => shop.close());
  const login = (await (
    await fetch(`${shop.url}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "standard", password: PASSWORD }),
    })
  ).json()) as { token: string };
  const input: AttemptInput = {
    specFile: spec(ticket, caseId),
    caseId,
    attempt: 1,
    plan: plan(ticket),
    baseUrl: shop.url,
    allowedOrigins: [shop.url],
    accounts: { "user:standard": { authorization: `Bearer ${login.token}` } },
    sessions: { "user:standard": login.token },
    secrets: [login.token, PASSWORD],
    timeoutMs: 30_000,
  };
  const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
  try {
    const browser = createPlaywrightBrowserFactory({
      video,
      webSession: { storage: "sessionStorage", key: "token" },
      actionTimeoutMs: 3000,
    });
    return { record: await executeAttempt(input, transport, Date.now, browser), token: login.token };
  } finally {
    await dispose();
  }
};

describe("web runner (REQ-EXEC-05, REQ-EXEC-07, REQ-EVD-02)", () => {
  it("REQ-EXEC-21/AC1+AC3: any test id attribute, and pages without test ids through placeholder, alt, title, id and roles", async () => {
    const page =
      "data:text/html," +
      encodeURIComponent(
        '<button data-qa="pay">Pay</button><input placeholder="Email"><img alt="Logo" src="data:,">' +
          '<span title="Hint">?</span><b id="total">9,99</b><button disabled>Buy</button>',
      );
    const session = createPlaywrightBrowserFactory({ video: "off", testIdAttribute: "data-qa" })({
      specFile: spec("DEMO-4", "TC-01"),
      caseId: "TC-01",
      attempt: 1,
      plan: plan("DEMO-4"),
      baseUrl: "http://127.0.0.1:9",
      allowedOrigins: [],
      accounts: {},
      secrets: [],
      timeoutMs: 30_000,
    });
    try {
      const d = await session.driver();
      await d.goto(page);
      expect(await d.property("testid:pay", "visible")).toBe(true);
      expect(await d.property("placeholder:Email", "visible")).toBe(true);
      expect(await d.property("alt:Logo", "visible")).toBe(true);
      expect(await d.property("title:Hint", "visible")).toBe(true);
      expect(await d.property("id:total", "text")).toBe("9,99");
      expect(await d.property("role:button:Buy", "enabled")).toBe(false);
      await expect(d.property("xpath://b", "visible")).rejects.toThrow(/not supported in a browser/);
      expect(await d.elements?.()).toContainEqual(expect.objectContaining({ testid: "pay", text: "Pay" }));
    } finally {
      await session.close(false);
    }
  });

  it("REQ-EXEC-22/AC1: the parent lists the elements of a page: test ids, roles, names, texts and states", async () => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD } });
    cleanups.push(() => shop.close());
    const login = (await (
      await fetch(`${shop.url}/auth/login`, {
        method: "POST",
        body: JSON.stringify({ username: "standard", password: PASSWORD }),
      })
    ).json()) as { token: string };
    const session = createPlaywrightBrowserFactory({
      video: "off",
      webSession: { storage: "sessionStorage", key: "token" },
    })({
      specFile: spec("DEMO-4", "TC-01"),
      caseId: "TC-01",
      attempt: 1,
      plan: plan("DEMO-4"),
      baseUrl: shop.url,
      allowedOrigins: [shop.url],
      accounts: {},
      sessions: { "user:standard": login.token },
      secrets: [login.token],
      timeoutMs: 30_000,
    });
    try {
      const driver = await session.driver();
      await driver.useAccount("user:standard");
      await driver.goto("/app/checkout");
      const elements = (await driver.elements?.()) ?? [];
      expect(elements).toContainEqual(
        expect.objectContaining({ testid: "place-order", role: "button", disabled: true }),
      );
      expect(elements).toContainEqual(expect.objectContaining({ testid: "accept-terms" }));
      expect(elements).toContainEqual(expect.objectContaining({ role: "button", disabled: true }));
      expect(elements.some((e) => e.role === "checkbox")).toBe(true);
      expect(JSON.stringify(elements)).not.toContain(login.token);
    } finally {
      await session.close(false);
    }
  });

  it("REQ-EXEC-05/AC3 + REQ-EVD-02/AC1+AC3 + REQ-NFR-04/AC1: a passing web case (BUG-05 off) has a screenshot per step, HAR and console log, no video", async () => {
    const { record, token } = await attempt("DEMO-4", "TC-01");
    expect(record.outcome).toBe("passed");
    expect(record.assertions.map((a) => [a.field, a.actual])).toEqual([
      ["elements.testid:place-order.enabled", false],
      ["elements.testid:place-order.enabled", true],
    ]);
    expect(record.evidence.map((e) => e.name)).toEqual(["S1.png", "S2.png", "network.har", "console.log"]);
    const har = String(record.evidence.find((e) => e.name === "network.har")?.content);
    expect(har).not.toContain(token);
  });

  it("REQ-NFR-04/AC1: BUG-05 (checkout button stays disabled) is FAILED with full-page screenshot, DOM, video and trace", async () => {
    const { record } = await attempt("DEMO-4", "TC-01", "BUG_CHECKOUT_BUTTON_DISABLED");
    expect(record.outcome).toBe("failed");
    expect(record.assertions[1]).toMatchObject({ actual: false, expected: true, pass: false });
    // REQ-EVD-08: the step that failed also gets its screenshot with the disabled button boxed, and the notes.
    expect(record.evidence.map((e) => e.name)).toEqual([
      "S1.png",
      "S2.png",
      "S2-annotated.png",
      "S2-annotations.json",
      "failure.png",
      "failure.html",
      "failure-elements.json",
      "trace.zip",
      "video.webm",
      "network.har",
      "console.log",
    ]);
    // REQ-EXEC-22/AC4: what the page showed at the failure, for the healer.
    const elements = String(record.evidence.find((e) => e.name === "failure-elements.json")?.content);
    expect(elements).toContain('"testid": "place-order"');
  });

  it("REQ-NFR-04/AC1: BUG-06 (price format) is FAILED; without it PASSED", async () => {
    expect((await attempt("DEMO-4", "TC-02")).record.outcome).toBe("passed");
    const { record } = await attempt("DEMO-4", "TC-02", "BUG_PRICE_FORMAT_LOCALE");
    expect(record.outcome).toBe("failed");
    expect(record.assertions[0]).toMatchObject({
      expected: "24,99 zł",
      actual: "(text not visible on the page)",
    });
  });

  it("REQ-EXEC-07 + REQ-NFR-04/AC1: the mixed case catches BUG-07 through the API although the UI shows success", async () => {
    expect((await attempt("DEMO-5", "TC-01")).record.outcome).toBe("passed");
    const { record } = await attempt("DEMO-5", "TC-01", "BUG_SILENT_500_TOAST");
    expect(record.outcome).toBe("failed");
    expect(record.assertions.map((a) => [a.stepId, a.field, a.pass])).toEqual([
      ["S1", "status", true],
      ["S2", "texts.0", true],
      ["S3", "status", true],
      ["S3", "fields.lines.length", false],
    ]);
  });

  it("REQ-EVD-06/AC1: video always when configured", async () => {
    const { record } = await attempt("DEMO-4", "TC-02", undefined, "always");
    expect(record.evidence.some((e) => e.name === "video.webm")).toBe(true);
  });

  it("masks HAR headers and cookies", () => {
    const har = JSON.stringify({
      log: {
        entries: [
          {
            request: {
              headers: [
                { name: "Authorization", value: "Bearer abc" },
                { name: "Accept", value: "x" },
              ],
              cookies: [{ name: "sid", value: "s" }],
            },
            response: { headers: [] },
          },
        ],
      },
    });
    const masked = maskHar(har, (t) => t);
    expect(masked).not.toContain("Bearer abc");
    expect(masked).toContain('"value": "x"');
    expect(maskHar("not json token", (t) => t.replace("token", "***"))).toBe("not json ***");
  });
});

describe("healing and parallel web runs (REQ-EXEC-09, REQ-EXEC-10)", () => {
  it("REQ-EXEC-09/AC3: a selector error is healed, re-run and ends NEEDS_REVIEW, never PASSED", async () => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD } });
    const dir = await mkdtemp(join(tmpdir(), "qj-heal-"));
    cleanups.push(
      () => shop.close(),
      () => remove(dir, { recursive: true, force: true }),
    );
    const brokenSpec = join(dir, "TC-02.spec.ts");
    await write(
      brokenSpec,
      readFileSync(spec("DEMO-4", "TC-02"), "utf8").replace('"testid:price-P-2"', '"testid:price-old"'),
    );
    const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
    cleanups.push(dispose);
    const browser = createPlaywrightBrowserFactory({
      actionTimeoutMs: 1000,
      webSession: { storage: "sessionStorage", key: "token" },
    });
    const healCalls: number[] = [];
    const results = await runCases({
      plan: plan("DEMO-4"),
      specs: new Map([
        ["TC-02", brokenSpec],
        ["TC-01", spec("DEMO-4", "TC-01")],
      ]),
      executor: (input) => executeAttempt(input, transport, Date.now, browser),
      evidence: createLocalEvidenceStore(join(dir, "evidence")),
      resultsDir: join(dir, "results"),
      baseUrl: shop.url,
      allowedOrigins: [shop.url],
      login: async () => {
        const r = (await (
          await fetch(`${shop.url}/auth/login`, {
            method: "POST",
            body: JSON.stringify({ username: "standard", password: PASSWORD }),
          })
        ).json()) as { token: string };
        return {
          accounts: { "user:standard": { authorization: `Bearer ${r.token}` } },
          secrets: [r.token],
          sessions: { "user:standard": r.token },
        };
      },
      retries: 1,
      workers: 2,
      heal: (caseId, _spec, failed, attemptNo) => {
        healCalls.push(attemptNo);
        expect(failed.outcome).toBe("error");
        return Promise.resolve(caseId === "TC-02" ? spec("DEMO-4", "TC-02") : undefined);
      },
      events: createEventLog({
        ticket: "DEMO-4",
        run: "r",
        write: () => undefined,
        now: () => new Date(0),
        mask: (v) => v,
      }),
      now: () => new Date(),
    });
    const tc2 = results.get("TC-02")!;
    expect(tc2.attempts.map((a) => [a.outcome, a.healed === true])).toEqual([
      ["error", false],
      ["error", false],
      ["passed", true],
    ]);
    expect(healCalls).toEqual([1]);
    expect(computeStatus({ caseId: "TC-02", attempts: tc2.attempts }, { evidenceComplete: true })).toBe(
      "NEEDS_REVIEW",
    );
    expect(results.get("TC-01")?.attempts.map((a) => a.outcome)).toEqual(["passed"]);
    expect([...results.keys()]).toEqual(["TC-01", "TC-02"]);
  }, 120_000);
});

describe("passive observations (REQ-EVD-07)", () => {
  const page = `<!doctype html><html><head><title>Shop</title></head><body>
<main><h1>Cart</h1><img src="/logo.png"><button></button>
<script>console.error("cart total is NaN"); fetch("/api/missing"); fetch("/api/broken");</script></main></body></html>`;
  const site = async () => {
    const { createServer } = await import("node:http");
    const server = createServer((req, res) => {
      if (req.url === "/") {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(page);
      } else if (req.url === "/api/broken") {
        res.writeHead(500);
        res.end();
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const url = `http://127.0.0.1:${String((server.address() as { port: number }).port)}`;
    cleanups.push(
      () =>
        new Promise((r) =>
          server.close(() => {
            r();
          }),
        ),
    );
    return url;
  };
  const visit = async (
    url: string,
    observations?: { console?: boolean; httpErrors?: boolean; accessibility?: boolean },
  ) => {
    const session = createPlaywrightBrowserFactory({
      video: "off",
      ...(observations ? { observations } : {}),
    })({
      specFile: "",
      caseId: "TC-01",
      attempt: 1,
      plan: plan("DEMO-4"),
      baseUrl: url,
      allowedOrigins: [url],
      accounts: {},
      secrets: ["cart total"],
      timeoutMs: 10_000,
    });
    const driver = await session.driver();
    await driver.goto("/");
    await new Promise((r) => setTimeout(r, 300));
    return session.close(false);
  };

  it("REQ-EVD-07/AC2+AC3: console errors, 4xx/5xx responses and axe violations of visited pages are recorded by the parent, masked", async () => {
    const items = await visit(await site());
    const file = items.find((i) => i.name === "observations.json");
    const observed = JSON.parse(String(file?.content)) as {
      console: { level: string; text: string; url: string }[];
      http: { method: string; url: string; status: number }[];
      accessibility: { rule: string; url: string; targets: string[] }[];
    };
    expect(observed.console).toEqual(
      expect.arrayContaining([{ level: "error", text: "*** is NaN", url: "/" }]),
    );
    expect(JSON.stringify(observed)).not.toContain("cart total");
    expect(observed.http).toEqual(
      expect.arrayContaining([
        { method: "GET", url: "/api/missing", status: 404 },
        { method: "GET", url: "/api/broken", status: 500 },
      ]),
    );
    const rules = observed.accessibility.map((a) => a.rule);
    expect(rules).toEqual(expect.arrayContaining(["image-alt", "button-name", "html-has-lang"]));
    expect(observed.accessibility.find((a) => a.rule === "image-alt")).toMatchObject({
      url: "/",
      targets: ["img"],
    });
  }, 60_000);

  it("REQ-EVD-07/AC5: each check can be switched off; a clean page writes no observations file", async () => {
    const items = await visit(await site(), { console: false, httpErrors: false, accessibility: false });
    expect(items.map((i) => i.name)).not.toContain("observations.json");
  }, 60_000);
});

describe("browser availability (REQ-EXEC-13/AC3)", () => {
  it("REQ-EXEC-13/AC3: a browser whose build is missing is unavailable, with the install command", () => {
    expect(browserUnavailable("firefox", () => false)).toBe(
      "firefox is not installed; install it with 'pnpm --filter @qajitsu/cli exec playwright-core install firefox'",
    );
    expect(browserUnavailable("chromium", () => true)).toBeUndefined();
  });

  it("REQ-EXEC-66/AC1+AC2: a branded channel is found at its vendor's install path, else named with qj setup", () => {
    expect(channelExecutables("chrome", "darwin")).toEqual([
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ]);
    expect(channelExecutables("msedge-beta", "linux")).toEqual(["/opt/microsoft/msedge-beta/msedge"]);
    expect(
      channelExecutables("msedge", "win32", {
        LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local",
        PROGRAMFILES: "C:\\Program Files",
      }),
    ).toEqual([
      "C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    ]);
    expect(channelExecutables("opera", "darwin")).toEqual([]);
    const mac = "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge";
    expect(browserUnavailable("msedge", (p) => p === mac, "darwin")).toBeUndefined();
    expect(browserUnavailable("chrome-beta", () => false, "darwin")).toBe(
      "chrome-beta is not installed; install it with 'qj setup' (Playwright's 'install chrome-beta', may ask for an administrator password)",
    );
  });

  it("REQ-EXEC-66/AC4: real Safari and specific versions are refused without a device farm, never replaced", () => {
    for (const name of ["safari", "chrome@118"] as const)
      expect(browserUnavailable(name, () => true)).toBe(
        `${name} runs only on a device farm (REQ-EXEC-35), which QAJitsu does not drive for web cases yet; it is never replaced by another browser`,
      );
  });
});

describe("traces kept as evidence (INV-8, REQ-EXEC-67/AC4)", () => {
  it("REQ-EXEC-67/AC4: secrets in a trace's text entries are masked; images stay; an unreadable trace is dropped", () => {
    const enc = (t: string) => new TextEncoder().encode(t);
    const png = new Uint8Array([137, 80, 78, 71, 0, 255, 254]);
    const trace = zip([
      { name: "trace.trace", data: enc('{"method":"fill","params":{"value":"pa55-word!"}}\n') },
      { name: "trace.network", data: enc('{"headers":[{"name":"cookie","value":"sid=0123456789abcdef"}]}') },
      {
        name: "resources/entry.json",
        data: enc('{"response":{"cookies":[{"name":"sid","value":"made-by-the-app"}],"status":200}}'),
      },
      { name: "resources/page@1.png", data: png },
    ]);
    const masked = unzip(
      maskTrace(trace, (t) => t.replaceAll("pa55-word!", "***").replaceAll("0123456789abcdef", "***")),
      { maxEntries: 10, maxEntryBytes: 1_000_000, maxTotalBytes: 1_000_000 },
    );
    const text = (n: string) => new TextDecoder().decode(masked.find((e) => e.name === n)?.data);
    expect(text("trace.trace")).toBe('{"method":"fill","params":{"value":"***"}}\n');
    // A sensitive header is masked by its name, whatever its value.
    expect(text("trace.network")).toBe('{"headers":[{"name":"cookie","value":"***"}]}');
    // A cookie the application set during the test is masked although nobody registered it.
    expect(text("resources/entry.json")).toBe(
      '{"response":{"cookies":[{"name":"sid","value":"***"}],"status":200}}',
    );
    expect(masked.find((e) => e.name === "resources/page@1.png")?.data).toEqual(png);
    const dropped = unzip(
      maskTrace(new Uint8Array([1, 2, 3]), (t) => t),
      {
        maxEntries: 10,
        maxEntryBytes: 1_000_000,
        maxTotalBytes: 1_000_000,
      },
    );
    expect(dropped.map((e) => e.name)).toEqual(["README.txt"]);
  });
});
