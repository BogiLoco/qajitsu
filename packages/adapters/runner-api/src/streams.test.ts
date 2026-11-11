import type { StreamHandlers } from "@qajitsu/steps";
import { afterEach, describe, expect, it, vi } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createStreamTransport, parseEventStream } from "./streams.js";

const PASSWORD = "fictional-demo-password";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const shopWith = async (flag?: string) => {
  const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) } });
  cleanups.push(() => shop.close());
  const { token } = (await (
    await fetch(`${shop.url}/auth/login`, {
      method: "POST",
      body: JSON.stringify({ username: "standard", password: PASSWORD }),
    })
  ).json()) as { token: string };
  return { url: shop.url, auth: { authorization: `Bearer ${token}` } };
};

/** Collects a stream's messages until it closes. */
const collect = () => {
  const messages: { text: string; event?: string; id?: string }[] = [];
  let resolveClosed: (v: { code: number; reason: string }) => void = () => undefined;
  const closed = new Promise<{ code: number; reason: string }>((r) => (resolveClosed = r));
  const handlers: StreamHandlers = {
    message: (text, e) => messages.push({ text, ...e }),
    close: (code, reason) => {
      resolveClosed({ code, reason });
    },
  };
  return { messages, closed, handlers };
};

describe("streams of the API runner against the demo shop (REQ-EXEC-47)", () => {
  const transport = createStreamTransport({ openTimeoutMs: 3000 });

  it("REQ-EXEC-47/AC1: a WebSocket opens with the account's header, sends and receives, and reports its close", async () => {
    const shop = await shopWith();
    const c = collect();
    const ws = await transport(
      { kind: "websocket", url: `${shop.url.replace("http:", "ws:")}/ws/prices`, headers: shop.auth },
      c.handlers,
    );
    ws.send(JSON.stringify({ subscribe: "P-2" }));
    expect(await c.closed).toEqual({ code: 1000, reason: "done" });
    expect(c.messages.map((m) => JSON.parse(m.text) as unknown)).toEqual([
      { type: "price", sku: "P-2", price: 24.99 },
      { type: "availability", sku: "P-2", available: true },
    ]);
  });

  it("REQ-EXEC-47/AC5: BUG-28 closes the feed with 1011 and its reason; a socket without login never opens", async () => {
    const shop = await shopWith("BUG_WS_FEED_CLOSES_EARLY");
    const c = collect();
    const ws = await transport(
      { kind: "websocket", url: `${shop.url.replace("http:", "ws:")}/ws/prices`, headers: shop.auth },
      c.handlers,
    );
    ws.send(JSON.stringify({ subscribe: "P-2" }));
    expect(await c.closed).toEqual({ code: 1011, reason: "price feed down" });
    expect(c.messages).toHaveLength(1);
    await expect(
      transport(
        { kind: "websocket", url: `${shop.url.replace("http:", "ws:")}/ws/prices`, headers: {} },
        collect().handlers,
      ),
    ).rejects.toThrow(/before it opened/);
  });

  it("REQ-EXEC-47/AC2: an event stream gives its events with name and id and ends with 1000; without login it is refused", async () => {
    const shop = await shopWith();
    const c = collect();
    await transport({ kind: "sse", url: `${shop.url}/events/orders`, headers: shop.auth }, c.handlers);
    expect(await c.closed).toEqual({ code: 1000, reason: "" });
    expect(c.messages.map((m) => [m.event, m.id, m.text])).toEqual([
      ["created", "1", '{"order":"O-1","status":"created"}'],
      ["paid", "2", '{"order":"O-1","status":"paid"}'],
      ["shipped", "3", '{"order":"O-1","status":"shipped"}'],
    ]);
    await expect(
      transport({ kind: "sse", url: `${shop.url}/events/orders`, headers: {} }, collect().handlers),
    ).rejects.toThrow("HTTP 401 application/json, not an event stream");
    const early = collect();
    const stream = await transport(
      { kind: "sse", url: `${shop.url}/events/orders`, headers: shop.auth },
      early.handlers,
    );
    stream.send("ignored");
    stream.close();
    expect(await early.closed).toEqual({ code: 1006, reason: "" });
  });

  it("REQ-EXEC-47/AC2: the event stream format: comments, multi-line data, CRLF and an incomplete rest", () => {
    expect(
      parseEventStream(
        ": hi\r\nevent: a\r\nid: 7\r\ndata: x\r\ndata: y\r\n\r\ndata\n\nretry: 5\n\ndata: half",
      ),
    ).toEqual({
      events: [{ event: "a", id: "7", data: "x\ny" }, { data: "" }],
      rest: "data: half",
    });
  });
});

describe("a WebSocket the server refuses (REQ-EXEC-47/AC5)", () => {
  /** A client that, like Node 22's, reports a refused handshake with `error` only, or also with `close` (Node 24+). */
  const refusingClient = (events: readonly ("error" | "close")[]) =>
    class {
      binaryType = "blob";
      readonly closed: number[] = [];
      private readonly listeners = new Map<string, ((e: unknown) => void)[]>();
      constructor() {
        setTimeout(() => {
          for (const name of events)
            for (const l of this.listeners.get(name) ?? [])
              l(name === "close" ? { code: 1006, reason: "" } : {});
        }, 5);
      }
      addEventListener(name: string, l: (e: unknown) => void) {
        this.listeners.set(name, [...(this.listeners.get(name) ?? []), l]);
      }
      close() {
        this.closed.push(1);
      }
      send() {
        return undefined;
      }
    };
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("REQ-EXEC-47/AC5: a refused handshake reports that the socket never opened, at once, on every Node.js version", async () => {
    for (const events of [["error"], ["error", "close"], ["close"]] as const) {
      vi.stubGlobal("WebSocket", refusingClient(events));
      const c = collect();
      let closedCalled = false;
      const started = Date.now();
      await expect(
        createStreamTransport({ openTimeoutMs: 2000 })(
          { kind: "websocket", url: "ws://127.0.0.1:9/ws/prices", headers: {} },
          { ...c.handlers, close: () => (closedCalled = true) },
        ),
        events.join("+"),
      ).rejects.toThrow(/before it opened/);
      // Not the open timeout: the refusal itself is the answer.
      expect(Date.now() - started, events.join("+")).toBeLessThan(1000);
      expect(closedCalled, events.join("+")).toBe(false);
    }
  });
});
