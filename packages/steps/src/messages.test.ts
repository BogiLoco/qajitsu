import { PlanSchema, type CapturedMessage, type CaseMessages } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime } from "./runtime.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-3",
  version: 1,
  summary: "Registration e-mail",
  cases: [
    {
      id: "TC-01",
      title: "Registration sends a confirmation e-mail",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        {
          id: "S1",
          action: "POST /register",
          expect: {
            description: "A confirmation e-mail arrives",
            message: { subject: "Confirm your account", body: "activate", within_s: 1 },
          },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

/** A fake inbox: messages appear after `deliverAfter` polls; the clock moves 100 ms per poll. */
const setup = (
  incoming: Omit<CapturedMessage, "id">[],
  options: { withService?: boolean; deliverAfter?: number } = {},
) => {
  let clock = 1_000_000;
  let polls = 0;
  const created: string[] = [];
  const masker = createMasker();
  masker.register("tok-SECRET-123");
  const service: CaseMessages = {
    timeoutMs: 1000,
    pollMs: 1,
    inbox: () => {
      created.push("box-1");
      return Promise.resolve({
        id: "box-1",
        email: "box-1@email.webhook.site",
        url: "https://webhook.site/box-1",
      });
    },
    capture: {
      createInbox: () => Promise.reject(new Error("unused")),
      deleteInbox: () => Promise.resolve(),
      messages: () => {
        polls += 1;
        clock += 100;
        return Promise.resolve(
          polls > (options.deliverAfter ?? 0) ? incoming.map((m, i) => ({ id: `m${String(i)}`, ...m })) : [],
        );
      },
    },
  };
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.resolve({ status: 201, headers: {}, text: "{}" }),
    masker,
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => clock,
    ...(options.withService === false ? {} : { messages: service }),
  });
  return { runtime, created, at: (offset: number) => new Date(1_000_000 + offset).toISOString() };
};

const play = async (runtime: ReturnType<typeof setup>["runtime"]) => {
  const { step, api, verify, inbox } = runtime.context;
  let address = "";
  let got: unknown;
  let error: unknown;
  try {
    await step("S1", async () => {
      address = await inbox.address();
      await api.post("/register", { email: address });
      got = await inbox.wait("S1");
      verify("S1", "message");
    });
  } catch (e) {
    error = e;
  }
  return { address, got, record: await runtime.finish(error) };
};

describe("message capture in steps (REQ-ENV-08)", () => {
  it("REQ-ENV-08/AC1+AC2+AC3: the case's inbox address goes into test data; the planned message is waited for, verified and kept as masked evidence", async () => {
    const { runtime, created } = setup(
      [
        {
          kind: "email",
          receivedAt: new Date(999_000).toISOString(),
          to: "box-1@email.webhook.site",
          subject: "Confirm your account",
          body: "old message from before the attempt: activate",
        },
        {
          kind: "email",
          receivedAt: new Date(1_000_200).toISOString(),
          to: "box-1@email.webhook.site",
          subject: "Confirm your account",
          body: "Click https://shop.example/activate?t=tok-SECRET-123 to activate.",
        },
      ],
      { deliverAfter: 1 },
    );
    const { address, got, record } = await play(runtime);
    expect(address).toBe("box-1@email.webhook.site");
    expect(created).toEqual(["box-1"]);
    expect(got).toEqual({
      to: "box-1@email.webhook.site",
      subject: "Confirm your account",
      body: "Click https://shop.example/activate?t=*** to activate.",
      links: ["https://shop.example/activate?t=***"],
    });
    expect(record.outcome).toBe("passed");
    expect(record.assertions).toEqual([
      expect.objectContaining({ stepId: "S1", field: "message", pass: true }),
    ]);
    const evidence = record.evidence.find((e) => e.kind === "message");
    expect(evidence?.name).toBe("S1-message.json");
    expect(String(evidence?.content)).toContain('"matched": true');
    expect(String(evidence?.content)).not.toContain("tok-SECRET-123");
  });

  it("REQ-ENV-08/AC2: no matching message in time makes the step fail, never pass; old messages do not count", async () => {
    const { runtime } = setup([
      {
        kind: "email",
        receivedAt: new Date(999_000).toISOString(),
        subject: "Confirm your account",
        body: "activate (sent before this attempt)",
      },
      {
        kind: "email",
        receivedAt: new Date(1_000_100).toISOString(),
        subject: "Newsletter",
        body: "activate later",
      },
    ]);
    const { got, record } = await play(runtime);
    expect(got).toBeUndefined();
    expect(record.outcome).toBe("failed");
    expect(record.assertions[0]).toMatchObject({
      field: "message",
      pass: false,
      actual: "(no matching message in time)",
    });
    expect(String(record.evidence.find((e) => e.kind === "message")?.content)).toContain('"matched": false');
  });

  it("REQ-ENV-08/AC2: waiting needs the planned step and a capture service; misuse is an error, never a pass", async () => {
    const none = await play(setup([], { withService: false }).runtime);
    expect(none.record.outcome).toBe("error");
    expect(none.record.error).toContain("no message capture");
    const { runtime } = setup([]);
    await expect(runtime.context.inbox.wait("S1")).rejects.toThrow(/inside step/);
    await expect(runtime.context.inbox.address()).rejects.toThrow(/inside step/);
    expect(runtime.context.plan.expect("TC-01.S1.message")).toEqual({
      subject: "Confirm your account",
      body: "activate",
      within_s: 1,
    });
  });
});

describe("message capture details (REQ-ENV-08/AC2)", () => {
  const plan2 = PlanSchema.parse({
    ...plan,
    cases: [
      {
        ...plan.cases[0],
        steps: [
          {
            id: "S1",
            action: "POST /hooks",
            expect: { description: "A webhook arrives", message: { body: "order.paid" } },
          },
          { id: "S2", action: "GET /health", expect: { description: "up", status: 200 } },
        ],
      },
    ],
  });
  const runtimeFor = (incoming: CapturedMessage[]) => {
    let clock = 5_000_000;
    return createCaseRuntime({
      plan: plan2,
      caseId: "TC-01",
      attempt: 1,
      baseUrl: "http://127.0.0.1:3000",
      transport: () => Promise.resolve({ status: 200, headers: {}, text: "{}" }),
      masker: createMasker(),
      allowedOrigins: ["http://127.0.0.1:3000"],
      accounts: {},
      now: () => (clock += 400),
      messages: {
        timeoutMs: 1000,
        inbox: () => Promise.resolve({ id: "b", email: "b@mail.local", url: "https://hooks.local/b" }),
        capture: {
          createInbox: () => Promise.reject(new Error("unused")),
          deleteInbox: () => Promise.resolve(),
          messages: () => Promise.resolve(incoming),
        },
      },
    });
  };

  it("REQ-ENV-08/AC2: a webhook (no sender or subject) matches by body; verify waits by itself; the URL address is available", async () => {
    const runtime = runtimeFor([
      {
        id: "h1",
        kind: "http",
        receivedAt: new Date(6_000_000).toISOString(),
        body: '{"event":"order.paid"}',
      },
    ]);
    const { step, verify, inbox } = runtime.context;
    let url = "";
    await step("S1", async () => {
      url = await inbox.address("url");
      verify("S1", "message");
    });
    expect(url).toBe("https://hooks.local/b");
    const record = await runtime.finish();
    expect(record.assertions[0]).toMatchObject({ field: "message", pass: true });
  });

  it("REQ-ENV-08/AC2: the default wait applies without within_s; a step without a planned message cannot wait", async () => {
    const runtime = runtimeFor([]);
    const { step, inbox, verify } = runtime.context;
    await expect(
      step("S2", async () => {
        await inbox.wait("S2");
      }),
    ).rejects.toThrow(/expects no message/);
    await step("S1", async () => {
      expect(await inbox.wait("S1")).toBeUndefined();
      verify("S1", "message");
    });
    const record = await runtime.finish();
    expect(record.assertions.find((a) => a.field === "message")).toMatchObject({ pass: false });
    expect(String(record.evidence.find((e) => e.kind === "message")?.content)).toContain('"waitedMs": 1000');
  });
});
