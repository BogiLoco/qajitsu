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
import { PlanSchema, createEventLog } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createPlaywrightBrowserFactory, maskHar } from "./browser.js";

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
    expect(record.evidence.map((e) => e.name)).toEqual([
      "S1.png",
      "S2.png",
      "failure.png",
      "failure.html",
      "trace.zip",
      "video.webm",
      "network.har",
      "console.log",
    ]);
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
