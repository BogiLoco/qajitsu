// Adversarial suite: specs that try to make a WebSocket or an event stream look like a result it is not
// (REQ-EXEC-47, invariants 1, 4 and 10). Messages are read from the stream by the trusted runtime, the runtime waits for
// them itself, a socket the spec closes early cannot pass, and a socket to another host is never opened.
import { PlanSchema } from "@qajitsu/core";
import {
  createCaseRuntime,
  createMasker,
  type AttemptRecord,
  type CaseRuntime,
  type StreamOpenRequest,
  type StreamTransport,
} from "@qajitsu/steps";
import { computeStatus } from "@qajitsu/verifier";
import { describe, expect, it } from "vitest";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-20",
  version: 1,
  summary: "Live prices.",
  cases: [
    {
      id: "TC-01",
      title: "A price subscription answers the price, then the availability",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "WS /ws/prices",
          stream: { timeout_s: 0.2 },
          expect: {
            description: "Price, then availability",
            messages: { "0.price": 24.99, "1.type": "availability", count: 2 },
          },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

/** A feed that answers with the given messages a few milliseconds after the subscription, then closes. */
const feed =
  (messages: readonly unknown[], opened: StreamOpenRequest[] = [], closeWith = 1000): StreamTransport =>
  (request, handlers) => {
    opened.push(request);
    return Promise.resolve({
      send: () => {
        messages.forEach((m, i) =>
          setTimeout(
            () => {
              handlers.message(JSON.stringify(m));
            },
            10 * (i + 1),
          ),
        );
        setTimeout(
          () => {
            handlers.close(closeWith, closeWith === 1000 ? "done" : "feed down");
          },
          10 * (messages.length + 1),
        );
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
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.reject(new Error("no HTTP")),
    masker: createMasker(),
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
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

const status = (record: AttemptRecord) =>
  computeStatus({ caseId: "TC-01", attempts: [record] }, { evidenceComplete: true });

const claimAll = (rt: CaseRuntime) => {
  const { verify, plan: p } = rt.context;
  // A lying spec passes the planned values as the actual ones.
  verify("S1", "messages.0.price", 24.99, p.expect("TC-01.S1.messages.0.price"));
  verify("S1", "messages.1.type", "availability", p.expect("TC-01.S1.messages.1.type"));
  verify("S1", "messages.count", 2, p.expect("TC-01.S1.messages.count"));
};

describe("a stream never becomes a result it is not (REQ-EXEC-47, invariants 1 and 4)", () => {
  it("REQ-EXEC-47/AC1: values the spec claims are replaced by the stream's own messages", async () => {
    const record = await run(feed([{ price: 19.99 }, { type: "error" }, { type: "extra" }]), async (rt) => {
      const ws = await rt.context.api.websocket("/ws/prices");
      await ws.send({ subscribe: "P-2" });
      claimAll(rt);
    });
    expect(record.assertions.map((a) => a.actual)).toEqual([19.99, "error", 3]);
    expect(status(record)).toBe("FAILED");
  });

  it("REQ-EXEC-47/AC1+AC5: a spec that closes the socket before the messages come cannot pass", async () => {
    const record = await run(feed([{ price: 24.99 }, { type: "availability" }]), async (rt) => {
      const ws = await rt.context.api.websocket("/ws/prices");
      await ws.send({ subscribe: "P-2" });
      await ws.close();
      claimAll(rt);
    });
    expect(status(record)).not.toBe("PASSED");
    expect(record.assertions.every((a) => !a.pass)).toBe(true);
  });

  it("REQ-EXEC-47/AC5: a feed that closes early with 1011 is FAILED with the code, never PASSED or hidden", async () => {
    const record = await run(feed([{ price: 24.99 }], [], 1011), async (rt) => {
      const ws = await rt.context.api.websocket("/ws/prices");
      await ws.send({ subscribe: "P-2" });
      claimAll(rt);
    });
    expect(status(record)).toBe("FAILED");
    expect(String(record.assertions[1]?.actual)).toContain("closed with 1011 feed down");
  });

  it("REQ-EXEC-47/AC4: a socket to a host outside the allowlist is never opened, and the case is BLOCKED", async () => {
    const opened: StreamOpenRequest[] = [];
    const record = await run(feed([{ price: 24.99 }, { type: "availability" }], opened), async (rt) => {
      try {
        await rt.context.api.websocket("ws://collector.example/ws");
      } catch {
        // A lying spec swallows the refusal and claims the plan's values.
      }
      claimAll(rt);
    });
    expect(opened).toHaveLength(0);
    expect(status(record)).not.toBe("PASSED");
  });

  it("REQ-EXEC-47/AC5: a stream that cannot be opened is BLOCKED, not FAILED", async () => {
    const refused: StreamTransport = () => Promise.reject(new Error("closed with 1006 before it opened"));
    const record = await run(refused, async (rt) => {
      await rt.context.api.events("/events/orders");
    });
    expect(record.error).toContain("could not be opened: closed with 1006 before it opened");
    expect(status(record)).toBe("BLOCKED");
  });
});
