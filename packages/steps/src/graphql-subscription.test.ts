import { PlanSchema } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime, type AttemptRecord, type CaseRuntime } from "./runtime.js";
import type { StreamOpenRequest, StreamTransport } from "./streams.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-18",
  version: 1,
  summary: "GraphQL subscriptions.",
  cases: [
    {
      id: "TC-04",
      title: "Price changes are pushed",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC4" }],
      steps: [
        {
          id: "S1",
          action: "WS /graphql",
          graphql: { operation: "Subscription.priceChanged" },
          stream: { timeout_s: 0.5 },
          expect: {
            description: "Two prices",
            messages: { "0.data.priceChanged.price": 24.99, "1.data.priceChanged.price": 22.49, count: 2 },
          },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

/** A graphql-transport-ws server: ack, a ping, two prices for the subscription, then complete. */
const server =
  (seen: string[], opened: StreamOpenRequest[], extra: readonly unknown[] = []): StreamTransport =>
  (request, handlers) => {
    opened.push(request);
    const reply = (frame: unknown, ms: number) =>
      setTimeout(() => {
        handlers.message(typeof frame === "string" ? frame : JSON.stringify(frame));
      }, ms);
    return Promise.resolve({
      send: (text) => {
        seen.push(text);
        const frame = JSON.parse(text) as { type: string; id?: string };
        if (frame.type === "connection_init") {
          reply({ type: "connection_ack" }, 1);
          reply({ type: "ping" }, 2);
        }
        if (frame.type === "subscribe") {
          [...extra, 24.99, 22.49].forEach((price, i) =>
            reply(
              typeof price === "number"
                ? { id: frame.id, type: "next", payload: { data: { priceChanged: { id: "P-2", price } } } }
                : price,
              5 * (i + 1),
            ),
          );
          reply({ id: frame.id, type: "complete" }, 5 * (extra.length + 3));
        }
      },
      close: () => undefined,
    });
  };

const run = async (
  transport: StreamTransport,
  body: (rt: CaseRuntime) => Promise<void>,
): Promise<AttemptRecord> => {
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-04",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.reject(new Error("no HTTP")),
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: { "user:standard": { authorization: "Bearer t" } },
    now: () => Date.now(),
    streams: transport,
  });
  try {
    await runtime.context.step("S1", () => body(runtime));
    return await runtime.finish();
  } catch (error) {
    return await runtime.finish(error);
  }
};

const QUERY = "subscription Prices($id: ID!) { priceChanged(id: $id) { id price } }";

describe("GraphQL subscriptions over WebSocket (REQ-EXEC-48/AC2)", () => {
  it("REQ-EXEC-48/AC2: api.subscribe speaks graphql-transport-ws; every payload is a message; the evidence is marked GraphQL", async () => {
    const seen: string[] = [];
    const opened: StreamOpenRequest[] = [];
    const record = await run(server(seen, opened), async (rt) => {
      const prices = await rt.context.api.as("user:standard").subscribe(QUERY, { id: "P-2" });
      for (const f of ["0.data.priceChanged.price", "1.data.priceChanged.price", "count"])
        rt.context.verify("S1", `messages.${f}`, undefined, rt.context.plan.expect(`TC-04.S1.messages.${f}`));
      await expect(prices.send("x")).rejects.toThrow(/sends nothing after its query/);
    });
    expect(record.outcome, record.error).toBe("passed");
    expect(opened[0]).toMatchObject({
      url: "ws://127.0.0.1:3000/graphql",
      protocols: ["graphql-transport-ws"],
      headers: { authorization: "Bearer t" },
    });
    expect(seen.map((t) => (JSON.parse(t) as { type: string }).type)).toEqual([
      "connection_init",
      "subscribe",
      "pong",
    ]);
    expect(JSON.parse(seen[1] ?? "")).toEqual({
      id: "1",
      type: "subscribe",
      payload: { query: QUERY, variables: { id: "P-2" } },
    });
    const log = JSON.parse(
      String(record.evidence.find((e) => e.name === "S1-websocket-01.json")?.content),
    ) as {
      graphql?: boolean;
      request?: unknown;
      closed?: unknown;
    };
    expect(log.graphql).toBe(true);
    expect(log.request).toEqual({ body: { query: QUERY, variables: { id: "P-2" } } });
    expect(log.closed).toEqual({ code: 1000, reason: "complete" });
  });

  it("REQ-EXEC-48/AC2+AC3: an error frame is a message of errors; frames that are not the protocol's are ignored", async () => {
    const record = await run(
      server([], [], ["not json", { type: "error", id: "1", payload: [{ message: "Price feed down" }] }]),
      async (rt) => {
        await rt.context.api.subscribe(QUERY, undefined, { path: "/api/graphql" });
        rt.context.verify(
          "S1",
          "messages.count",
          undefined,
          rt.context.plan.expect("TC-04.S1.messages.count"),
        );
      },
    );
    expect(record.assertions[0]?.actual).toBe(3);
    const log = String(record.evidence.find((e) => e.name === "S1-websocket-01.json")?.content);
    expect(log).toContain("Price feed down");
  });

  it("REQ-EXEC-48/AC2: a subscription whose query is not a string, or whose variables are not an object, is refused", async () => {
    const opened: StreamOpenRequest[] = [];
    const bad = await run(server([], opened), async (rt) => {
      await rt.context.api.subscribe(5 as unknown as string);
    });
    expect(bad.error).toContain("api.subscribe: the query must be a string");
    const list = await run(server([], opened), async (rt) => {
      await rt.context.api.subscribe(QUERY, [1] as unknown as Record<string, unknown>);
    });
    expect(list.error).toContain("the variables an object");
    expect(opened).toHaveLength(0);
  });
});
