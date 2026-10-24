import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { createPlaywrightTransport, executeAttempt, type AttemptInput } from "@qajitsu/adapter-runner-api";
import { PlanSchema } from "@qajitsu/core";
import { computeStatus } from "@qajitsu/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createPlaywrightBrowserFactory } from "./browser.js";

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

const attempt = async (ticket: string, caseId: string, flag?: string) => {
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
});
