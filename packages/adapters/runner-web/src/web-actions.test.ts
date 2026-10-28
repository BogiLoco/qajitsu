import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPlaywrightTransport, executeAttempt, type AttemptInput } from "@qajitsu/adapter-runner-api";
import { PlanSchema, unzip } from "@qajitsu/core";
import { computeStatus } from "@qajitsu/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { channelExecutables, createPlaywrightBrowserFactory } from "./browser.js";

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
  browserName?: "chromium" | "firefox" | "webkit" | "chrome",
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
      video: "off",
      webSession: { storage: "sessionStorage", key: "token" },
      actionTimeoutMs: 4000,
      ...(browserName ? { browser: browserName } : {}),
    });
    const record = await executeAttempt(input, transport, Date.now, browser);
    return { record, status: computeStatus({ caseId, attempts: [record] }, { evidenceComplete: true }) };
  } finally {
    await dispose();
  }
};

/** A browser on a data: page or the shop, outside a case, for the driver's own behaviour. */
const driverOn = async (allowedOrigins: string[] = [], maxDownloadBytes?: number) => {
  const session = createPlaywrightBrowserFactory({
    video: "off",
    actionTimeoutMs: 1500,
    ...(maxDownloadBytes === undefined ? {} : { maxDownloadBytes }),
  })({
    specFile: spec("DEMO-9", "TC-01"),
    caseId: "TC-01",
    attempt: 1,
    plan: plan("DEMO-9"),
    baseUrl: allowedOrigins[0] ?? "http://127.0.0.1:9",
    allowedOrigins,
    accounts: {},
    secrets: [],
    timeoutMs: 30_000,
  });
  cleanups.push(async () => {
    await session.close(false);
  });
  return session.driver();
};
const html = (body: string) => `data:text/html,${encodeURIComponent(body)}`;

describe("web actions (REQ-EXEC-38, REQ-EXEC-39, REQ-EXEC-40, REQ-EXEC-56)", () => {
  it("REQ-EXEC-38/AC1+AC3 + REQ-NFR-04/AC1: an avatar uploaded through the file input passes; BUG-09 (limit too low) is FAILED", async () => {
    const ok = await attempt("DEMO-7", "TC-01");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    // AC3: the generated upload is evidence.
    expect(ok.record.evidence.map((e) => `${e.kind}:${e.name}`)).toContain("upload:S1-upload-avatar.png");
    expect((await attempt("DEMO-7", "TC-01", "BUG_AVATAR_LIMIT_TOO_LOW")).status).toBe("FAILED");
  });

  it("REQ-EXEC-38/AC1: a file dropped on a drop zone reaches the page", async () => {
    const r = await attempt("DEMO-7", "TC-02");
    expect(r.record.error).toBeUndefined();
    expect(r.status).toBe("PASSED");
  });

  it("REQ-EXEC-38/AC2+AC3 + REQ-NFR-04/AC1: the CSV export is checked by name, type, rows and content; BUG-10 (last row missing) is FAILED", async () => {
    const ok = await attempt("DEMO-7", "TC-03");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    const download = ok.record.evidence.find((e) => e.kind === "download");
    expect(download?.name).toBe("S1-download-products.csv");
    expect(String(download?.content)).toContain("P-3,T-shirt");
    const bad = await attempt("DEMO-7", "TC-03", "BUG_EXPORT_DROPS_LAST_ROW");
    expect(bad.status).toBe("FAILED");
    expect(bad.record.assertions.filter((a) => !a.pass).map((a) => a.field)).toEqual([
      "download.rows",
      "download.texts.0",
    ]);
  });

  it("REQ-EXEC-39/AC1+AC2 + REQ-NFR-04/AC1: a payment inside an iframe with a 3-D Secure pop-up; BUG-11 (result ignored) is FAILED", async () => {
    const ok = await attempt("DEMO-8", "TC-01");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    // AC2: the evidence names the page of every action.
    const log = ok.record.evidence.find((e) => e.name === "ui-actions.json");
    const actions = JSON.parse(String(log?.content)) as { op: string; page?: number }[];
    expect(actions.find((a) => a.op === "click" && a.page === 1)).toBeDefined();
    expect(actions.find((a) => a.op === "closePage")?.page).toBe(0);
    expect((await attempt("DEMO-8", "TC-01", "BUG_3DS_RESULT_IGNORED")).status).toBe("FAILED");
  });

  it("REQ-EXEC-40/AC1 + REQ-NFR-04/AC1: drag and drop moves a card; BUG-12 (wrong column) is FAILED; hover shows details", async () => {
    const ok = await attempt("DEMO-9", "TC-01");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    expect((await attempt("DEMO-9", "TC-01", "BUG_DRAG_WRONG_COLUMN")).status).toBe("FAILED");
    expect((await attempt("DEMO-9", "TC-02")).status).toBe("PASSED");
  });

  it("REQ-EXEC-40/AC2: scrolling an infinite list until an element appears, within the step's limit, and checking it is in view", async () => {
    const r = await attempt("DEMO-9", "TC-03");
    expect(r.record.error).toBeUndefined();
    expect(r.status).toBe("PASSED");
    const log = JSON.parse(
      String(r.record.evidence.find((e) => e.name === "ui-actions.json")?.content),
    ) as Record<string, unknown>[];
    expect(log.find((a) => a["op"] === "scrollUntil.result")).toMatchObject({ found: true, limit: 30 });
  });

  it("REQ-EXEC-56/AC1+AC2 + REQ-NFR-04/AC1: stars inside an open shadow root and the chart's test state; BUG-13 (off by one) is FAILED", async () => {
    const ok = await attempt("DEMO-9", "TC-04");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    const bad = await attempt("DEMO-9", "TC-04", "BUG_RATING_OFF_BY_ONE");
    expect(bad.status).toBe("FAILED");
    expect(bad.record.assertions.filter((a) => !a.pass).map((a) => a.field)).toEqual([
      "elements.testid:rating-value.text",
      "state.bars.3.value",
    ]);
  });

  it("REQ-EXEC-56/AC1: an element behind a closed shadow root is named as unreachable", async () => {
    const d = await driverOn();
    await d.goto(
      html(
        `<x-closed id="legacy"></x-closed><script>customElements.define("x-closed",class extends HTMLElement{connectedCallback(){this.attachShadow({mode:"closed"}).innerHTML='<button data-testid="reveal">Reveal</button>'}})</script>`,
      ),
    );
    await expect(d.click("testid:reveal")).rejects.toThrow();
    expect(await d.unreachableReason?.()).toContain("closed shadow roots (in x-closed#legacy)");
  });

  it("REQ-EXEC-39/AC3: a pop-up to a host outside the allowlist is BLOCKED with the host named; no pop-up at all is named too", async () => {
    const d = await driverOn();
    await d.goto(
      html(`<button data-testid="open" onclick="window.open('https://pay.example.com/3ds')">Open</button>`),
    );
    await d.click("testid:open");
    await expect(d.switchPage?.("new", 3000)).rejects.toThrow(
      "the pop-up opened https://pay.example.com, which is not on the environment allowlist",
    );
    await expect(d.switchPage?.("new", 300)).rejects.toThrow("no pop-up or tab opened within 0.3 s");
    await expect(d.closePage?.()).rejects.toThrow("the first page of the case cannot be closed");
  });

  it("REQ-EXEC-38/AC1 + REQ-EXEC-40/AC1+AC2: a button opening the file chooser, double and right click, keys, dragging by an offset, scrolling, no test hook", async () => {
    const d = await driverOn();
    await d.goto(
      html(`<input type="file" id="f" hidden onchange="document.getElementById('n').textContent=this.files[0].name">
<button data-testid="choose" onclick="document.getElementById('f').click()">Choose</button><span data-testid="n" id="n"></span>
<button data-testid="b" ondblclick="this.textContent='double'" oncontextmenu="event.preventDefault();this.dataset.r='1';document.getElementById('r').textContent='right'">b</button><span data-testid="r" id="r"></span>
<input data-testid="i" value="abc"><div data-testid="drag" id="d" style="position:absolute;left:10px;top:200px;width:40px;height:40px;background:red"
 onmousedown="window.sx=event.clientX"></div><span data-testid="m" id="m"></span>
<div style="height:3000px"></div><p data-testid="bottom">end</p>
<script>document.addEventListener("mouseup",(e)=>{if(window.sx!==undefined)document.getElementById("m").textContent=String(e.clientX-window.sx)})</script>`),
    );
    await d.upload?.("testid:choose", [
      { name: "a.txt", type: "text/plain", data: new TextEncoder().encode("x") },
    ]);
    expect(await d.property("testid:n", "text")).toBe("a.txt");
    await d.pointer?.("testid:b", "dblclick");
    expect(await d.property("testid:b", "text")).toBe("double");
    await d.pointer?.("testid:b", "rightclick");
    expect(await d.property("testid:r", "text")).toBe("right");
    await d.click("testid:i");
    await d.keys?.("ControlOrMeta+A");
    await d.keys?.("Backspace");
    expect(await d.property("testid:i", "value")).toBe("");
    await d.dragBy?.("testid:drag", 60, 0);
    expect(await d.property("testid:m", "text")).toBe("60");
    expect(await d.property("testid:bottom", "in_viewport")).toBe(false);
    await d.scrollTo?.("testid:bottom");
    expect(await d.property("testid:bottom", "in_viewport")).toBe(true);
    await d.scrollBy?.(0, -3000);
    expect(await d.property("testid:bottom", "in_viewport")).toBe(false);
    expect(await d.scrollUntil?.("testid:missing", 2)).toMatchObject({ found: false, scrolls: 2 });
    expect(await d.testState?.("__QA_STATE__", "a")).toEqual({ hook: false, value: undefined });
    expect(await d.property("testid:missing", "in_viewport")).toBe(false);
  });

  it("REQ-EXEC-38/AC2+AC4 + INV-10: a download larger than the limit or from a host outside the allowlist is refused, never read", async () => {
    const server = createServer((req, res) => {
      if (req.url === "/big.bin") {
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "content-disposition": 'attachment; filename="big.bin"',
        });
        res.end(Buffer.alloc(5000));
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<a data-testid="big" href="/big.bin">Big</a> <a data-testid="far" href="https://files.example.com/report.csv" download>Far</a>',
      );
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(
      () =>
        new Promise((done) =>
          server.close(() => {
            done();
          }),
        ),
    );
    const address = server.address();
    const origin = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;
    const d = await driverOn([origin], 1000);
    await d.goto(`${origin}/`);
    await expect(d.download?.("testid:big", 3000)).rejects.toThrow(
      "has 5000 bytes, more than 1000 a test reads",
    );
    await expect(d.download?.("testid:far", 1500)).rejects.toThrow();
  });

  it("REQ-EXEC-61/AC1 + REQ-NFR-04/AC1: a confirm dialog is answered as the step says and checked; BUG-14 (cancel deletes) is FAILED", async () => {
    const ok = await attempt("DEMO-10", "TC-01");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    const shown = JSON.parse(
      String(ok.record.evidence.find((e) => e.name === "S1-dialogs.json")?.content),
    ) as unknown[];
    expect(shown).toEqual([{ type: "confirm", message: "Delete this address?", answer: "dismissed" }]);
    expect((await attempt("DEMO-10", "TC-01", "BUG_DELETE_IGNORES_CANCEL")).status).toBe("FAILED");
  });

  it("REQ-EXEC-61/AC2 + REQ-NFR-04/AC1: the case starts at the plan's time and a step moves it; BUG-15 (offer never ends) is FAILED", async () => {
    const ok = await attempt("DEMO-10", "TC-02");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    expect((await attempt("DEMO-10", "TC-02", "BUG_OFFER_NEVER_EXPIRES")).status).toBe("FAILED");
  });

  it("REQ-EXEC-61/AC3: a granted location reaches the page; without the permission it stays denied", async () => {
    const ok = await attempt("DEMO-10", "TC-03");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    const d = await driverOn();
    await d.goto(
      html(
        `<button data-testid="where" onclick="navigator.geolocation.getCurrentPosition(()=>{s.textContent='allowed'},()=>{s.textContent='denied'})">Where</button><span id="s" data-testid="s"></span>`,
      ),
    );
    await d.click("testid:where");
    await d.waitFor("testid:s", "visible");
    expect(await d.property("testid:s", "text")).toBe("denied");
  });

  it("REQ-EXEC-61/AC1: a prompt gets the plan's text; a dialog no step expected is dismissed and recorded", async () => {
    const d = await driverOn();
    await d.goto(
      html(
        `<button data-testid="ask" onclick="r.textContent=String(prompt('Your name?'))">Ask</button><span id="r" data-testid="r"></span>`,
      ),
    );
    d.setDialogPolicy?.({ action: "accept", text: "Ada" });
    await d.click("testid:ask");
    expect(await d.property("testid:r", "text")).toBe("Ada");
    d.setDialogPolicy?.(undefined);
    await d.click("testid:ask");
    expect(await d.property("testid:r", "text")).toBe("null");
    expect(d.takeDialogs?.()).toEqual([
      { type: "prompt", message: "Your name?", answer: "accepted with text" },
      { type: "prompt", message: "Your name?", answer: "dismissed" },
    ]);
    expect(d.takeDialogs?.()).toEqual([]);
  });

  it("REQ-EXEC-61/AC5: an environment behind Basic Auth is reached by the browser and the API client with the profile's credentials", async () => {
    const server = createServer((req, res) => {
      if (req.headers.authorization !== `Basic ${Buffer.from("qa:fictional-pass").toString("base64")}`) {
        res.writeHead(401, { "www-authenticate": 'Basic realm="staging"' }).end("no");
        return;
      }
      res.writeHead(200, { "content-type": "text/html" }).end('<p data-testid="in">inside</p>');
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    cleanups.push(
      () =>
        new Promise((done) =>
          server.close(() => {
            done();
          }),
        ),
    );
    const address = server.address();
    const origin = `http://127.0.0.1:${String(typeof address === "object" && address ? address.port : 0)}`;
    const session = createPlaywrightBrowserFactory({
      video: "off",
      httpCredentials: { username: "qa", password: "fictional-pass" },
    })({
      specFile: spec("DEMO-9", "TC-01"),
      caseId: "TC-01",
      attempt: 1,
      plan: plan("DEMO-9"),
      baseUrl: origin,
      allowedOrigins: [origin],
      accounts: {},
      secrets: [],
      timeoutMs: 30_000,
    });
    cleanups.push(async () => {
      await session.close(false);
    });
    const d = await session.driver();
    await d.goto(`${origin}/`);
    expect(await d.property("testid:in", "text")).toBe("inside");
    const { transport, dispose } = await createPlaywrightTransport({
      timeoutMs: 5000,
      httpCredentials: { username: "qa", password: "fictional-pass" },
    });
    try {
      expect((await transport({ method: "GET", url: `${origin}/`, headers: {} })).status).toBe(200);
    } finally {
      await dispose();
    }
    const { transport: bare, dispose: closeBare } = await createPlaywrightTransport({ timeoutMs: 5000 });
    try {
      expect((await bare({ method: "GET", url: `${origin}/`, headers: {} })).status).toBe(401);
    } finally {
      await closeBare();
    }
  });

  it("REQ-EXEC-64/AC1+AC2: a repeated button is reached through its row; nth picks a match; without narrowing the page says how many", async () => {
    const r = await attempt("DEMO-10", "TC-04");
    expect(r.record.error).toBeUndefined();
    expect(r.status).toBe("PASSED");
    const d = await driverOn();
    await d.goto(
      html(`<table><tr><td>Anna</td><td><button onclick="o.textContent='Anna'">Delete</button></td></tr>
<tr><td>Bob</td><td><button onclick="o.textContent='Bob'">Delete</button></td></tr></table><span id="o" data-testid="o"></span>`),
    );
    await expect(d.click("role:button:Delete")).rejects.toThrow("resolved to 2 elements");
    await d.click("role:row >> has-text:Bob >> role:button:Delete");
    expect(await d.property("testid:o", "text")).toBe("Bob");
    await d.click("role:button:Delete >> nth:1");
    expect(await d.property("testid:o", "text")).toBe("Anna");
  });

  it("REQ-EXEC-65/AC1+AC3: an installable page is read from its manifest and controlled by its allowed service worker", async () => {
    const ok = await attempt("DEMO-11", "TC-01");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    expect(ok.record.assertions.map((a) => [a.field, a.actual])).toEqual([
      ["manifest.short_name", "Notes"],
      ["manifest.display", "standalone"],
      ["manifest.icons", 1],
      ["manifest.controlled", true],
    ]);
  });

  it("REQ-EXEC-65/AC1: service workers outside Chromium are BLOCKED with the reason", async () => {
    const r = await attempt("DEMO-11", "TC-01", undefined, "firefox");
    expect(r.status).toBe("BLOCKED");
    expect(r.record.error).toMatch(/service workers.*only in Chromium, not in firefox/);
  });

  it("REQ-EXEC-65/AC2 + REQ-NFR-04/AC1: a note written offline is saved back online; BUG-16 (offline notes lost) is FAILED", async () => {
    const ok = await attempt("DEMO-11", "TC-02");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    const lost = await attempt("DEMO-11", "TC-02", "BUG_OFFLINE_NOTES_LOST");
    expect(lost.status).toBe("FAILED");
    expect(lost.record.assertions.filter((a) => !a.pass).map((a) => [a.field, a.actual])).toEqual([
      ["elements.testid:saved-count.text", "0"],
    ]);
  });

  it("REQ-EXEC-65/AC1: an allowed service worker's own requests stay on the allowlist", async () => {
    const outside: string[] = [];
    const other = createServer((req, res) => {
      outside.push(req.url ?? "");
      res.end("leaked");
    });
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const otherUrl = `http://127.0.0.1:${String((other.address() as { port: number }).port)}`;
    const app = createServer((req, res) => {
      if (req.url === "/sw.js") {
        res.writeHead(200, { "content-type": "text/javascript" });
        res.end(
          `self.addEventListener("install",(e)=>{self.skipWaiting();e.waitUntil(fetch("${otherUrl}/from-worker").catch(()=>undefined));});self.addEventListener("activate",(e)=>e.waitUntil(self.clients.claim()));`,
        );
        return;
      }
      res.writeHead(200, { "content-type": "text/html" });
      res.end(`<p data-testid="p">ok</p><script>navigator.serviceWorker.register("/sw.js");</script>`);
    });
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
    const appUrl = `http://127.0.0.1:${String((app.address() as { port: number }).port)}`;
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          other.close(() => {
            done();
          });
        }),
      () =>
        new Promise<void>((done) => {
          app.close(() => {
            done();
          });
        }),
    );
    const session = createPlaywrightBrowserFactory({ video: "off", actionTimeoutMs: 3000 })({
      specFile: spec("DEMO-11", "TC-01"),
      caseId: "TC-01",
      attempt: 1,
      plan: plan("DEMO-11"),
      baseUrl: appUrl,
      allowedOrigins: [appUrl],
      accounts: {},
      secrets: [],
      timeoutMs: 30_000,
    });
    cleanups.push(async () => {
      await session.close(false);
    });
    const d = await session.driver();
    await d.goto("/");
    expect((await d.manifest?.())?.controlled).toBe(true);
    expect(outside).toEqual([]);
  });

  it("REQ-EXEC-66/AC3: every attempt records the exact browser it ran in", async () => {
    const r = await attempt("DEMO-11", "TC-02");
    expect(r.record.browser?.name).toBe("chromium");
    expect(r.record.browser?.version).toMatch(/^\d+\.\d+/);
  });

  // Runs where Google Chrome is installed (developer machines, GitHub's runners); elsewhere `qj setup` installs it.
  it.skipIf(!channelExecutables("chrome").some((p) => existsSync(p)))(
    "REQ-EXEC-66/AC1+AC3: a case runs in the installed Google Chrome, named with its version",
    async () => {
      const r = await attempt("DEMO-11", "TC-01", undefined, "chrome");
      expect(r.record.error).toBeUndefined();
      expect(r.status).toBe("PASSED");
      expect(r.record.browser).toMatchObject({ name: "chrome" });
      expect(r.record.browser?.version).toMatch(/^\d+\.\d+/);
    },
  );

  it("REQ-EVD-09/AC1: the driver sees every request of the page: errors, allowlist refusals and login redirects", async () => {
    const app = createServer((req, res) => {
      if (req.url === "/api/orders") {
        res.writeHead(500);
        res.end("boom");
      } else if (req.url === "/api/account") {
        res.writeHead(302, { location: "/login?next=/account" });
        res.end();
      } else if (req.url === "/login?next=/account") {
        res.end("login");
      } else {
        res.writeHead(200, { "content-type": "text/html" });
        res.end(
          `<p data-testid="p">ok</p><script>fetch("/api/orders",{method:"POST"});fetch("/api/account");fetch("http://127.0.0.1:9/track").catch(()=>0);</script>`,
        );
      }
    });
    await new Promise<void>((done) => app.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${String((app.address() as { port: number }).port)}`;
    cleanups.push(
      () =>
        new Promise<void>((done) => {
          app.close(() => {
            done();
          });
        }),
    );
    const d = await driverOn([url]);
    await d.goto(`${url}/shop`);
    await d.waitFor("testid:p", "visible");
    await new Promise((r) => setTimeout(r, 500));
    const taken = d.takeNetwork?.() ?? [];
    expect(taken.find((r) => r.url === "/api/account")?.location).toBe("/login?next=/account");
    const seen = taken.map((r) => [r.method, r.url, r.status ?? r.failure, r.refused === true]);
    expect(seen).toEqual(
      expect.arrayContaining([
        ["GET", "/shop", 200, false],
        ["POST", "/api/orders", 500, false],
        ["GET", "/api/account", 302, false],
        ["GET", "http://127.0.0.1:9/track", undefined, true],
      ]),
    );
    expect(d.takeNetwork?.()).toEqual([]);
  });

  it("REQ-EXEC-47/AC3+AC4 + REQ-NFR-04/AC1: the page's WebSocket messages are checked and kept; BUG-17 (reply drops the text) is FAILED", async () => {
    const ok = await attempt("DEMO-12", "TC-01");
    expect(ok.record.error).toBeUndefined();
    expect(ok.status).toBe("PASSED");
    const frames = JSON.parse(
      String(ok.record.evidence.find((e) => e.name === "S2-websocket.json")?.content),
    ) as { direction: string; text: string }[];
    expect(frames.map((f) => f.direction)).toEqual(["sent", "received"]);
    expect(frames[1]?.text).toContain("Support received: Where is my order?");
    const bug = await attempt("DEMO-12", "TC-01", "BUG_CHAT_REPLY_DROPS_TEXT");
    expect(bug.status).toBe("FAILED");
    expect(bug.record.assertions.filter((a) => !a.pass).map((a) => [a.field, a.actual])).toEqual([
      ["websocket.received.0", "(no received WebSocket message contains it)"],
    ]);
  }, 60_000);

  /** DEMO-13 with the session in an HttpOnly cookie, logged in the way the environment login does it. */
  const signedIn = async (caseId: string, flag?: string) => {
    const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) } });
    cleanups.push(() => shop.close());
    const res = await fetch(`${shop.url}/auth/session`, {
      method: "POST",
      body: JSON.stringify({ username: "standard", password: PASSWORD }),
    });
    const sid = /sid=([0-9a-f]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? "";
    const { transport, dispose } = await createPlaywrightTransport({ timeoutMs: 5000 });
    try {
      const record = await executeAttempt(
        {
          specFile: spec("DEMO-13", caseId),
          caseId,
          attempt: 1,
          plan: plan("DEMO-13"),
          baseUrl: shop.url,
          allowedOrigins: [shop.url],
          accounts: { "user:standard": { cookie: `sid=${sid}` } },
          browserStates: {
            "user:standard": {
              cookies: [{ name: "sid", value: sid, path: "/", httpOnly: true, sameSite: "Lax" }],
            },
          },
          credential: (alias, field) =>
            alias === "user:standard" ? (field === "password" ? PASSWORD : "standard") : undefined,
          secrets: [sid, PASSWORD],
          timeoutMs: 30_000,
        },
        transport,
        Date.now,
        createPlaywrightBrowserFactory({
          video: "off",
          webSession: { storage: "cookies" },
          actionTimeoutMs: 4000,
        }),
      );
      return { record, status: computeStatus({ caseId, attempts: [record] }, { evidenceComplete: true }) };
    } finally {
      await dispose();
    }
  };

  it("REQ-EXEC-67/AC3+AC4: a sign-in form gets the account's secrets typed by the runner; nothing records them in clear", async () => {
    const r = await signedIn("TC-01");
    expect(r.record.error).toBeUndefined();
    expect(r.status).toBe("PASSED");
    for (const item of r.record.evidence) {
      const text = typeof item.content === "string" ? item.content : new TextDecoder().decode(item.content);
      expect(text, item.name).not.toContain(PASSWORD);
    }
  });

  it("REQ-EXEC-67/AC1+AC2: the login's HttpOnly cookie opens the account page through ui.as", async () => {
    const r = await signedIn("TC-03");
    expect(r.record.error).toBeUndefined();
    expect(r.status).toBe("PASSED");
  });

  it("REQ-NFR-04/AC1: a wrong password is refused; BUG-18 (any password signs in) is FAILED", async () => {
    expect((await signedIn("TC-02")).status).toBe("PASSED");
    const bug = await signedIn("TC-02", "BUG_SIGNIN_ANY_PASSWORD");
    expect(bug.status).toBe("FAILED");
    expect(bug.record.assertions.map((a) => [a.field, a.actual])).toEqual([
      ["elements.testid:signin-result.text", "Signed in"],
    ]);
    // The failed attempt keeps its trace; the session cookie the browser was given is masked in it.
    const trace = bug.record.evidence.find((e) => e.name === "trace.zip")?.content;
    expect(trace).toBeInstanceOf(Uint8Array);
    const texts = unzip(trace as Uint8Array, { maxEntries: 20_000, maxEntryBytes: 2e8, maxTotalBytes: 5e8 })
      .filter((e) => !/\.(png|jpe?g)$/.test(e.name))
      .map((e) => new TextDecoder().decode(e.data))
      .join("\n");
    expect(texts).toContain("signin-username");
    expect(texts).not.toMatch(/sid=[0-9a-f]{32}/);
  });

  it("REQ-EXEC-55/AC4: a test header of the application (captcha bypass) goes to its own origin only, from the browser and the API client", async () => {
    const seen: { where: string; header: string | undefined }[] = [];
    const listen = (name: string, html: (other: string) => string) => {
      const server = createServer((req, res) => {
        seen.push({
          where: `${name}${req.url ?? ""}`,
          header: req.headers["x-captcha-bypass"] as string | undefined,
        });
        res.writeHead(200, { "content-type": "text/html", "access-control-allow-origin": "*" });
        res.end(html(""));
      });
      return new Promise<string>((done) => {
        server.listen(0, "127.0.0.1", () => {
          cleanups.push(
            () =>
              new Promise<void>((closed) => {
                server.close(() => {
                  closed();
                });
              }),
          );
          done(`http://127.0.0.1:${String((server.address() as { port: number }).port)}`);
        });
      });
    };
    const other = await listen("other", () => "ok");
    const app = await listen(
      "app",
      () => `<p data-testid="p">ok</p><script>fetch("${other}/x");fetch("/api")</script>`,
    );
    const session = createPlaywrightBrowserFactory({
      video: "off",
      testHeaders: { "X-Captcha-Bypass": "bypass-key-123" },
    })({
      specFile: spec("DEMO-11", "TC-01"),
      caseId: "TC-02",
      attempt: 1,
      plan: plan("DEMO-11"),
      baseUrl: app,
      allowedOrigins: [app, other],
      accounts: {},
      secrets: [],
      timeoutMs: 30_000,
    });
    cleanups.push(async () => {
      await session.close(false);
    });
    const d = await session.driver();
    await d.goto("/");
    await d.waitFor("testid:p", "visible");
    await new Promise((r) => setTimeout(r, 500));
    const { transport, dispose } = await createPlaywrightTransport({
      timeoutMs: 5000,
      testHeaders: { origin: app, headers: { "X-Captcha-Bypass": "bypass-key-123" } },
    });
    await transport({ method: "GET", url: `${app}/from-api`, headers: {} });
    await transport({ method: "GET", url: `${other}/from-api`, headers: {} });
    await dispose();
    const byWhere = Object.fromEntries(seen.map((x) => [x.where, x.header]));
    expect(byWhere["app/"]).toBe("bypass-key-123");
    expect(byWhere["app/api"]).toBe("bypass-key-123");
    expect(byWhere["app/from-api"]).toBe("bypass-key-123");
    expect(byWhere["other/x"]).toBeUndefined();
    expect(byWhere["other/from-api"]).toBeUndefined();
  });
});
