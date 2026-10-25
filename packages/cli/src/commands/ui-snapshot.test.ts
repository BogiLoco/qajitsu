import type { BrowserFactory } from "@qajitsu/adapter-runner-api";
import { PlanSchema, type UiElementFact } from "@qajitsu/core";
import type { UiDriver } from "@qajitsu/steps";
import { describe, expect, it } from "vitest";
import { crawlUiSnapshot, recordUiSnapshot, snapshotPages } from "./ui-snapshot.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-4",
  version: 1,
  cases: [
    {
      id: "TC-01",
      title: "Checkout needs the terms",
      type: "web",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      preconditions: ["Logged in as user:standard with one item in the cart"],
      steps: [
        { id: "S1", action: "Open /app/checkout", expect: { description: "d", texts: ["x"] } },
        {
          id: "S2",
          action: "Call GET /cart and go to /app/cart/",
          expect: { description: "d", texts: ["y"] },
        },
      ],
      evidence: ["screenshot"],
    },
    {
      id: "TC-02",
      title: "App",
      type: "mobile",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [{ id: "S1", action: "Tap add", expect: { description: "d", texts: ["x"] } }],
      evidence: ["screenshot"],
    },
    {
      id: "TC-03",
      title: "Home",
      type: "web",
      priority: "low",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [{ id: "S1", action: "Look at the home page", expect: { description: "d", texts: ["x"] } }],
      evidence: ["screenshot"],
    },
  ],
});
const [web, mobile, home] = plan.cases as [
  (typeof plan.cases)[0],
  (typeof plan.cases)[0],
  (typeof plan.cases)[0],
];

const fakeFactory =
  (pages: Record<string, readonly UiElementFact[]>, calls: string[], fail?: string): BrowserFactory =>
  (input) => {
    let where = "app:start";
    const driver = {
      useAccount: (alias: string) => {
        calls.push(`as ${alias} (${Object.keys(input.sessions ?? {}).join(",")})`);
        return Promise.resolve();
      },
      goto: (path: string) => {
        if (path === fail) return Promise.reject(new Error(`net::ERR at ${path} secret-token`));
        where = path;
        calls.push(`goto ${path}`);
        return Promise.resolve();
      },
      elements: () => Promise.resolve(pages[where] ?? []),
    } as unknown as UiDriver;
    return {
      driver: () => Promise.resolve(driver),
      close: (failed) => {
        calls.push(`close ${String(failed)}`);
        return Promise.resolve([{ stepId: "case", kind: "log", name: "console.log", content: "x" }]);
      },
    };
  };

describe("snapshot of the running application in qj run (REQ-EXEC-22)", () => {
  it("REQ-EXEC-22/AC1: a case's pages are the paths it names that are UI pages, else the start page", () => {
    expect(snapshotPages(web, ["/app/cart", "/app/checkout"])).toEqual(["/app/checkout", "/app/cart"]);
    // Without the code every path the case names is tried (no inventory to tell API paths apart).
    expect(snapshotPages(web, [])).toEqual(["/app/checkout", "/cart", "/app/cart"]);
    expect(snapshotPages(home, ["/app/cart"])).toEqual(["/"]);
  });

  it("REQ-EXEC-22/AC1+AC2: pages are opened as the case's account, the app's first screen too; masked, no evidence kept", async () => {
    const calls: string[] = [];
    const events: [string, unknown][] = [];
    const logins: string[] = [];
    const screens = await recordUiSnapshot({
      plan,
      cases: [web, mobile, home],
      web: {
        factory: fakeFactory(
          {
            "/app/checkout": [{ testid: "place-order", role: "button", text: "Pay secret-token" }],
            "/app/cart": [{ role: "heading", name: "Cart" }],
            "/": [{ role: "link", name: "Shop" }],
          },
          calls,
        ),
        login: (aliases) => {
          logins.push(aliases.join(","));
          return Promise.resolve({
            accounts: {},
            secrets: ["secret-token"],
            sessions: Object.fromEntries(aliases.map((a) => [a, "secret-token"])),
            release: () => {
              calls.push("release");
            },
          });
        },
        aliases: ["user:standard", "user:admin"],
        knownPages: ["/app/cart", "/app/checkout"],
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins: ["http://127.0.0.1:3000"],
      },
      mobile: {
        factory: fakeFactory({ "app:start": [{ role: "Button", testid: "add-item" }] }, calls),
        platform: "android",
      },
      mask: (v) => JSON.parse(JSON.stringify(v).replaceAll("secret-token", "***")) as unknown,
      emit: (event, details) => events.push([event, details]),
    });
    expect(screens).toEqual([
      {
        where: "/app/checkout",
        platform: "web",
        account: "user:standard",
        elements: [{ testid: "place-order", role: "button", text: "Pay ***" }],
      },
      {
        where: "/app/cart",
        platform: "web",
        account: "user:standard",
        elements: [{ role: "heading", name: "Cart" }],
      },
      { where: "/", platform: "web", elements: [{ role: "link", name: "Shop" }] },
      { where: "app:start", platform: "android", elements: [{ role: "Button", testid: "add-item" }] },
    ]);
    expect(logins).toEqual(["user:standard"]);
    expect(calls).toEqual([
      "as user:standard (user:standard)",
      "goto /app/checkout",
      "goto /app/cart",
      "close false",
      "release",
      "goto /",
      "close false",
      "close false",
    ]);
    expect(events.map(([e]) => e)).toEqual(["ui.snapshot", "ui.snapshot", "ui.snapshot", "ui.snapshot"]);
    expect(events[0]?.[1]).toEqual({ where: "/app/checkout", platform: "web", elements: 1 });
  });

  it("REQ-EXEC-22/AC6: a page or screen that cannot be recorded is reported and the others go on", async () => {
    const calls: string[] = [];
    const events: [string, unknown][] = [];
    const failingDevice: BrowserFactory = () => ({
      driver: () => Promise.reject(new Error("no device")),
      close: () => Promise.resolve([]),
    });
    const screens = await recordUiSnapshot({
      plan,
      cases: [web, mobile],
      web: {
        factory: fakeFactory({ "/app/cart": [{ role: "heading", name: "Cart" }] }, calls, "/app/checkout"),
        login: () => Promise.reject(new Error("login failed for secret-token")),
        aliases: ["user:standard"],
        knownPages: ["/app/cart", "/app/checkout"],
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins: ["http://127.0.0.1:3000"],
      },
      mobile: { factory: failingDevice, platform: "android" },
      mask: (v) => JSON.parse(JSON.stringify(v).replaceAll("secret-token", "***")) as unknown,
      emit: (event, details) => events.push([event, details]),
    });
    expect(screens).toEqual([]);
    expect(events).toEqual([
      ["ui.snapshot.failed", { where: "/app/checkout", platform: "web", error: "login failed for ***" }],
      ["ui.snapshot.failed", { where: "app:start", platform: "android", error: "no device" }],
    ]);
  });

  it("REQ-EXEC-22/AC6: a page that cannot be opened is skipped; a driver without element listing records nothing", async () => {
    const calls: string[] = [];
    const events: [string, unknown][] = [];
    const bare: BrowserFactory = () => ({
      driver: () => Promise.resolve({ goto: () => Promise.resolve() } as unknown as UiDriver),
      close: () => Promise.resolve([]),
    });
    const screens = await recordUiSnapshot({
      plan,
      cases: [web, mobile],
      web: {
        factory: fakeFactory({ "/app/cart": [{ role: "heading", name: "Cart" }] }, calls, "/app/checkout"),
        login: (aliases) =>
          Promise.resolve({
            accounts: {},
            secrets: [],
            sessions: Object.fromEntries(aliases.map((a) => [a, "t"])),
          }),
        aliases: ["user:standard"],
        knownPages: ["/app/cart", "/app/checkout"],
        baseUrl: "http://127.0.0.1:3000",
        allowedOrigins: ["http://127.0.0.1:3000"],
      },
      mobile: { factory: bare, platform: "ios" },
      mask: (v) => JSON.parse(JSON.stringify(v).replaceAll("secret-token", "***")) as unknown,
      emit: (event, details) => events.push([event, details]),
    });
    expect(screens.map((s) => s.where)).toEqual(["/app/cart"]);
    expect(events[0]).toEqual([
      "ui.snapshot.failed",
      { where: "/app/checkout", platform: "web", error: "net::ERR at /app/checkout ***" },
    ]);
  });

  it("REQ-EXEC-22/AC5+AC7: without the code, pages reachable from the start page are recorded, same origin only, up to a limit", async () => {
    const calls: string[] = [];
    const events: [string, unknown][] = [];
    const link = (href: string) => ({ role: "link", name: href, href });
    const screens = await crawlUiSnapshot({
      factory: fakeFactory(
        {
          "/": [
            link("/app/products"),
            link("https://elsewhere.example/x"),
            link("#top"),
            link("mailto:a@b.c"),
          ],
          "/app/products": [
            link("/app/cart?x=1"),
            link("/app/products"),
            link("http://127.0.0.1:3000/app/login"),
          ],
          "/app/cart": [{ role: "heading", name: "Cart" }, link("/app/checkout")],
          "/app/login": [{ role: "textbox", name: "Username" }],
          "/app/checkout": [{ role: "button", name: "Pay" }],
        },
        calls,
        "/app/login",
      ),
      login: (aliases) =>
        Promise.resolve({
          accounts: {},
          secrets: [],
          sessions: Object.fromEntries(aliases.map((a) => [a, "t"])),
        }),
      account: "user:standard",
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins: ["http://127.0.0.1:3000"],
      maxPages: 4,
      mask: (v) => v,
      emit: (event, details) => events.push([event, details]),
    });
    expect(screens.map((s) => [s.where, s.account])).toEqual([
      ["/", "user:standard"],
      ["/app/products", "user:standard"],
      ["/app/cart", "user:standard"],
      ["/app/checkout", "user:standard"],
    ]);
    expect(calls).toEqual([
      "as user:standard (user:standard)",
      "goto /",
      "goto /app/products",
      "goto /app/cart",
      "goto /app/checkout",
      "close false",
    ]);
    expect(events.filter(([e]) => e === "ui.snapshot.failed")).toEqual([
      [
        "ui.snapshot.failed",
        { where: "/app/login", platform: "web", error: "net::ERR at /app/login secret-token" },
      ],
    ]);
  });

  it("REQ-EXEC-22/AC1: pages the code defines are recorded right after the start page, even when no link reaches them", async () => {
    const calls: string[] = [];
    const screens = await crawlUiSnapshot({
      factory: fakeFactory(
        {
          "/": [{ role: "heading", name: "Shop" }],
          "/app/offer": [{ role: "status", name: "Expires in 10:00" }],
        },
        calls,
      ),
      login: () => Promise.reject(new Error("unused")),
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins: ["http://127.0.0.1:3000"],
      paths: ["/app/offer", "/", "https://evil.example/x", "/a b"],
      mask: (v) => v,
      emit: () => undefined,
    });
    expect(screens.map((s) => s.where)).toEqual(["/", "/app/offer"]);
    expect(calls.filter((c) => c.startsWith("goto"))).toEqual(["goto /", "goto /app/offer"]);
  });

  it("REQ-EXEC-22/AC6+AC7: without an account the start page is opened anonymously; a failed login records nothing", async () => {
    const calls: string[] = [];
    const events: [string, unknown][] = [];
    const base = {
      factory: fakeFactory({ "/": [{ role: "heading", name: "Shop" }] }, calls),
      baseUrl: "http://127.0.0.1:3000",
      allowedOrigins: ["http://127.0.0.1:3000"],
      mask: (v: unknown) => v,
      emit: (event: string, details: Record<string, unknown>) => events.push([event, details]),
    };
    const anonymous = await crawlUiSnapshot({ ...base, login: () => Promise.reject(new Error("unused")) });
    expect(anonymous).toEqual([
      { where: "/", platform: "web", elements: [{ role: "heading", name: "Shop" }] },
    ]);
    const none = await crawlUiSnapshot({
      ...base,
      account: "user:standard",
      login: () => Promise.reject(new Error("bad password")),
    });
    expect(none).toEqual([]);
    expect(events.at(-1)).toEqual([
      "ui.snapshot.failed",
      { where: "/", platform: "web", error: "bad password" },
    ]);
  });
});
