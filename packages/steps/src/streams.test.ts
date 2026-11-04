import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, type AttemptRecord } from "./runtime.js";
import type { StreamOpenRequest, StreamTransport } from "./streams.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-20",
  version: 1,
  summary: "Live prices.",
  cases: [
    {
      id: "TC-01",
      title: "The price feed answers a subscription",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "WS /ws/prices",
          stream: { timeout_s: 0.3 },
          expect: {
            description: "Price, then stock",
            messages: { "0.type": "price", "0.price": 24.99, "1.type": "stock", count: 2 },
          },
        },
        {
          id: "S3",
          action: "GET /events/plain",
          expect: { description: "One event", messages: { "0.event": "message", "0.id": null, "1": "x" } },
        },
        {
          id: "S2",
          action: "GET /events/orders",
          stream: { timeout_s: 0.3 },
          expect: {
            description: "Created, then paid",
            messages: { "0.event": "created", "1.data.status": "paid" },
          },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const SECRET = "tok-very-secret-1234";

/** A feed that answers a subscription with a price and the stock; `closeAfter` ends it early with 1011. */
const feed =
  (opened: StreamOpenRequest[], behaviour: { closeAfter?: number; refuse?: string } = {}): StreamTransport =>
  (request, handlers) => {
    opened.push(request);
    if (behaviour.refuse) return Promise.reject(new Error(behaviour.refuse));
    if (request.kind === "sse") {
      setTimeout(() => {
        handlers.message(JSON.stringify({ status: "created" }), { event: "created", id: "1" });
        handlers.message(JSON.stringify({ status: "paid", token: SECRET }), { event: "paid", id: "2" });
        handlers.close(1000, "");
      }, 5);
    }
    return Promise.resolve({
      send: (text) => {
        const messages = [
          { type: "price", sku: "P-2", price: 24.99 },
          { type: "stock", sku: "P-2", stock: 5 },
        ];
        if (!text.includes("subscribe")) return;
        messages.forEach((m, i) =>
          setTimeout(
            () => {
              if (behaviour.closeAfter !== undefined && i >= behaviour.closeAfter) {
                if (i === behaviour.closeAfter) handlers.close(1011, "price feed down");
                return;
              }
              handlers.message(JSON.stringify(m));
            },
            5 * (i + 1),
          ),
        );
      },
      close: () => undefined,
    });
  };

const run = async (
  transport: StreamTransport | undefined,
  body: (rt: ReturnType<typeof createCaseRuntime>) => Promise<void>,
  allowed = ["http://127.0.0.1:3000"],
): Promise<AttemptRecord> => {
  const masker = createMasker();
  masker.register(SECRET);
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.reject(new Error("no HTTP here")),
    masker,
    allowedOrigins: allowed,
    accounts: { "user:standard": { authorization: `Bearer ${SECRET}` } },
    now: () => Date.now(),
    streams: transport,
  });
  try {
    await body(runtime);
    return await runtime.finish();
  } catch (error) {
    return await runtime.finish(error);
  }
};

const priceChecks = async (rt: ReturnType<typeof createCaseRuntime>) => {
  const { api, step, verify, plan: p } = rt.context;
  await step("S1", async () => {
    const ws = await api.as("user:standard").websocket("/ws/prices");
    await ws.send({ subscribe: "P-2" });
    for (const f of ["0.type", "0.price", "1.type", "count"])
      verify("S1", `messages.${f}`, undefined, p.expect(`TC-01.S1.messages.${f}`));
  });
};

describe("WebSocket and server-sent events in API steps (REQ-EXEC-47)", () => {
  it("REQ-EXEC-47/AC1+AC4: a WebSocket opens with the account's auth; planned messages, order and count are checked; frames are masked evidence", async () => {
    const opened: StreamOpenRequest[] = [];
    const record = await run(feed(opened), priceChecks);
    expect(record.outcome, record.error).toBe("passed");
    expect(record.assertions.map((a) => [a.field, a.actual])).toEqual([
      ["messages.0.type", "price"],
      ["messages.0.price", 24.99],
      ["messages.1.type", "stock"],
      ["messages.count", 2],
    ]);
    expect(opened[0]).toMatchObject({ kind: "websocket", url: "ws://127.0.0.1:3000/ws/prices" });
    expect(opened[0]?.headers["authorization"]).toBe(`Bearer ${SECRET}`);
    const log = String(record.evidence.find((e) => e.name === "S1-websocket-01.json")?.content);
    expect(log).toContain('"dir": "sent"');
    expect(log).toContain('\\"subscribe\\":\\"P-2\\"');
    expect(log).toContain('"price\\":24.99');
  });

  it("REQ-EXEC-47/AC2+AC4: an event stream's events are { event, id, data }; a secret in an event is masked in the evidence", async () => {
    let received: readonly unknown[] = [];
    const record = await run(feed([]), async (rt) => {
      const { api, step, verify, plan: p } = rt.context;
      let events: Awaited<ReturnType<typeof api.events>> | undefined;
      await step("S2", async () => {
        events = await api.as("user:standard").events("/events/orders");
        verify("S2", "messages.0.event", "created", p.expect("TC-01.S2.messages.0.event"));
        verify("S2", "messages.1.data.status", "paid", p.expect("TC-01.S2.messages.1.data.status"));
        await expect(events.send("x")).rejects.toThrow(/cannot send/);
      });
      received = (await events?.messages()) ?? [];
    });
    expect(received).toEqual([
      { event: "created", id: "1", data: { status: "created" } },
      { event: "paid", id: "2", data: { status: "paid", token: SECRET } },
    ]);
    expect(record.outcome, record.error).toBe("passed");
    const log = String(record.evidence.find((e) => e.name === "S2-events-01.json")?.content);
    expect(log).toContain('"event": "paid"');
    expect(log).not.toContain(SECRET);
  });

  it("REQ-EXEC-47/AC5: a feed that closes early fails the step with the close code and reason, never passes", async () => {
    const record = await run(feed([], { closeAfter: 1 }), priceChecks);
    expect(record.outcome).toBe("failed");
    expect(record.assertions.find((a) => a.field === "messages.1.type")?.actual).toBe(
      "(no message 1 within 0.3 s (the stream closed with 1011 price feed down))",
    );
    expect(record.assertions.find((a) => a.field === "messages.count")?.actual).toBe(1);
  });

  it("REQ-EXEC-47/AC1: a message that never comes fails the step at the plan's timeout", async () => {
    const silent: StreamTransport = () => Promise.resolve({ send: () => undefined, close: () => undefined });
    const record = await run(silent, priceChecks);
    expect(record.outcome).toBe("failed");
    expect(record.assertions[0]?.actual).toBe("(no message 0 within 0.3 s)");
    expect(record.assertions.at(-1)?.actual).toBe(0);
  });

  it("REQ-EXEC-47/AC5+AC4: a stream that cannot open, or to another host, is the step's error: BLOCKED with the reason", async () => {
    const refused = await run(feed([], { refuse: "HTTP 401" }), priceChecks);
    expect(refused.outcome).toBe("error");
    expect(refused.error).toContain(
      "the WebSocket ws://127.0.0.1:3000/ws/prices could not be opened: HTTP 401",
    );
    const opened: StreamOpenRequest[] = [];
    const elsewhere = await run(feed(opened), async (rt) => {
      await rt.context.step("S1", async () => {
        await rt.context.api.websocket("wss://evil.example/ws");
      });
    });
    expect(elsewhere.error).toContain("URL https://evil.example is not in the environment allowlist");
    expect(opened).toHaveLength(0);
    const secure = await run(
      feed(opened),
      async (rt) => {
        await rt.context.step("S1", async () => {
          await rt.context.api.websocket("https://shop.test/ws", { protocols: ["v1"] });
        });
      },
      ["https://shop.test"],
    );
    expect(secure.outcome).toBe("passed");
    expect(opened[0]).toMatchObject({ url: "wss://shop.test/ws", protocols: ["v1"] });
  });

  it("REQ-EXEC-47: no transport, no stream, a closed socket and an unplanned message are refused", async () => {
    const none = await run(undefined, priceChecks);
    expect(none.error).toContain("this runner has no streams");
    const noStream = await run(feed([]), async (rt) => {
      await rt.context.step("S1", () => {
        rt.context.verify("S1", "messages.count", 2, rt.context.plan.expect("TC-01.S1.messages.count"));
        return Promise.resolve();
      });
    });
    expect(noStream.error).toContain("needs a stream opened in the step");
    const closed = await run(feed([]), async (rt) => {
      await rt.context.step("S1", async () => {
        const ws = await rt.context.api.websocket("/ws/prices");
        await ws.close();
        await ws.close();
        await expect(ws.send("x")).rejects.toThrow(/closed \(1000\)/);
      });
    });
    expect(closed.outcome).toBe("passed");
    const unplanned = await run(feed([]), async (rt) => {
      await rt.context.step("S1", () => {
        rt.context.plan.expect("TC-01.S1.messages.5");
        return Promise.resolve();
      });
    });
    expect(unplanned.error).toContain("no expected message '5'");
    expect(closed.error).toBeUndefined();
    const outside = await run(feed([]), () => rt0(feed([])));
    expect(outside.outcome).toBe("passed");
  });
});

/** Opening a stream outside a step is refused. */
const rt0 = async (transport: StreamTransport) => {
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.reject(new Error("no")),
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => 0,
    streams: transport,
  });
  await expect(runtime.context.api.websocket("/ws")).rejects.toThrow(/inside step/);
  await runtime.context.step("S2", async () => {
    await expect(runtime.context.api.as("user:none").events("/e")).rejects.toThrow(/Unknown account/);
  });
};

describe("streams: the less common paths (REQ-EXEC-47)", () => {
  it("REQ-EXEC-47/AC2+AC5: an unnamed event, a close without a reason, the default timeout and the sandbox's operations", async () => {
    const plain: StreamTransport = (_request, handlers) => {
      setTimeout(() => {
        handlers.message("hello");
        handlers.close(1011, "");
      }, 5);
      return Promise.resolve({ send: () => undefined, close: () => undefined });
    };
    let sent = "";
    const record = await run(plain, async (rt) => {
      const handle = await (async () => {
        let h = -1;
        await rt.context.step("S3", async () => {
          h = await rt.openStream(undefined, "sse", "/events/plain");
          for (const f of ["0.event", "0.id", "1"])
            rt.context.verify(
              "S3",
              `messages.${f}`,
              undefined,
              rt.context.plan.expect(`TC-01.S3.messages.${f}`),
            );
        });
        return h;
      })();
      expect(await rt.streamOp(handle, "messages")).toEqual([{ event: "message", id: null, data: "hello" }]);
      await expect(rt.streamOp(handle, "send", "x")).rejects.toThrow(/cannot send/);
      await rt.streamOp(handle, "close");
      await expect(rt.streamOp(9, "messages")).rejects.toThrow("no stream 9");
    });
    expect(record.assertions.map((a) => a.actual)).toEqual([
      "message",
      null,
      "(no message 1 within 10 s (the stream closed with 1011))",
    ]);
    const echo: StreamTransport = () =>
      Promise.resolve({
        send: (text) => {
          sent = text;
        },
        close: () => undefined,
      });
    await run(echo, async (rt) => {
      await rt.context.step("S1", async () => {
        const ws = await rt.context.api.websocket("/ws/prices");
        await ws.send("plain text");
      });
    });
    expect(sent).toBe("plain text");
  });

  it("REQ-EXEC-47/AC5: no transport for an event stream, a path that is not text and a refusal that is not an Error", async () => {
    const none = await run(undefined, async (rt) => {
      await rt.context.step("S2", async () => {
        await rt.context.api.events("/events/orders");
      });
    });
    expect(none.error).toContain("api.events: this runner has no streams");
    const odd = await run(feed([]), async (rt) => {
      await rt.context.step("S1", async () => {
        await rt.context.api.websocket(5 as unknown as string);
      });
    });
    expect(odd.error).toContain("a stream's path must be a string");
    const refused: StreamTransport = () => {
      // A transport that throws something other than an Error.
      // eslint-disable-next-line @typescript-eslint/only-throw-error
      throw "gone";
    };
    const gone = await run(refused, async (rt) => {
      await rt.context.step("S2", async () => {
        await rt.context.api.events("/events/orders");
      });
    });
    expect(gone.error).toContain(
      "the event stream http://127.0.0.1:3000/events/orders could not be opened: gone",
    );
  });
});
