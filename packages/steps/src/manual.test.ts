import { PlanSchema, type ManualAnswer, type ManualStepRequest } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createMasker } from "./masking.js";
import { createCaseRuntime } from "./runtime.js";

const plan = PlanSchema.parse({
  schema: 1,
  ticket: "DEMO-1",
  version: 1,
  summary: "Login with a one-time code",
  cases: [
    {
      id: "TC-01",
      title: "Login with an SMS code",
      type: "api",
      priority: "high",
      source: [{ kind: "ac", id: "AC1" }],
      steps: [
        { id: "S1", action: "GET /health", expect: { description: "API is up", status: 200 } },
        {
          id: "S2",
          action: "Enter the SMS code on the phone",
          manual: true,
          instructions: "Type the code from the SMS into the app and confirm.",
          expect: { description: "The dashboard opens" },
        },
      ],
      evidence: ["response"],
    },
  ],
  open_questions: [],
  out_of_scope: [],
});

const runtimeWith = (manual?: (r: ManualStepRequest) => Promise<ManualAnswer | undefined>) => {
  const masker = createMasker();
  masker.register("s3cret-pass");
  const asked: ManualStepRequest[] = [];
  const runtime = createCaseRuntime({
    plan,
    caseId: "TC-01",
    attempt: 1,
    baseUrl: "http://127.0.0.1:3000",
    transport: () => Promise.resolve({ status: 200, headers: {}, text: "{}" }),
    masker,
    allowedOrigins: ["http://127.0.0.1:3000"],
    accounts: {},
    now: () => 0,
    ...(manual
      ? {
          manual: (r: ManualStepRequest) => {
            asked.push(r);
            return manual(r);
          },
        }
      : {}),
  });
  const play = async () => {
    const { step, api, verify } = runtime.context;
    await step("S1", async () => {
      await api.get("/health");
      verify("S1", "status");
    });
    await step("S2", () => undefined);
    return runtime.finish();
  };
  return { runtime, asked, play };
};

const answer = (over: Partial<ManualAnswer> = {}): ManualAnswer => ({
  outcome: "passed",
  by: "alice",
  at: "2026-10-07T10:00:00.000Z",
  ...over,
});

describe("manual steps (REQ-EXEC-11)", () => {
  it("REQ-EXEC-11/AC1: only steps of the approved plan are manual, with instructions and a description-only expectation", () => {
    const base = (plan.cases[0] as unknown as { steps: unknown[] }).steps[1] as Record<string, unknown>;
    const parse = (step: Record<string, unknown>) =>
      PlanSchema.safeParse({ ...plan, cases: [{ ...plan.cases[0], steps: [step] }] }).success;
    expect(parse(base)).toBe(true);
    expect(parse({ ...base, instructions: undefined })).toBe(false);
    expect(parse({ ...base, expect: { description: "x", status: 200 } })).toBe(false);
  });

  it("REQ-EXEC-11/AC2+AC3+AC7: the run asks a person; the outcome is an assertion from source manual with who and when; codes are masked", async () => {
    const { asked, play } = runtimeWith(() =>
      Promise.resolve(
        answer({
          note: "Code 482913 arrived after 5 s; password s3cret-pass",
          attachment: { name: "phone.png", content: new Uint8Array([1, 2]) },
        }),
      ),
    );
    const record = await play();
    expect(asked).toEqual([
      {
        caseId: "TC-01",
        stepId: "S2",
        attempt: 1,
        action: "Enter the SMS code on the phone",
        instructions: "Type the code from the SMS into the app and confirm.",
        expected: "The dashboard opens",
      },
    ]);
    expect(record.outcome).toBe("passed");
    const manual = record.assertions.find((a) => a.stepId === "S2");
    expect(manual).toEqual({
      stepId: "S2",
      field: "manual",
      expected: "passed",
      actual: "passed",
      pass: true,
      source: "manual",
      by: "alice",
      at: "2026-10-07T10:00:00.000Z",
      note: "Code *** arrived after 5 s; password ***",
    });
    // REQ-EXEC-11/AC3+AC7: the record and the attachment are evidence of the step; codes and secrets are masked.
    const evidence = record.evidence.filter((e) => e.stepId === "S2");
    expect(evidence.map((e) => [e.kind, e.name])).toEqual([
      ["manual", "S2-manual.json"],
      ["manual", "S2-phone.png"],
    ]);
    expect(String(evidence[0]?.content)).not.toContain("482913");
    expect(String(evidence[0]?.content)).not.toContain("s3cret-pass");
  });

  it("REQ-EXEC-11/AC5: a manual step reported failed makes the attempt failed", async () => {
    const record = await runtimeWith(() =>
      Promise.resolve(answer({ outcome: "failed", note: "dashboard did not open" })),
    ).play();
    expect(record.outcome).toBe("failed");
    expect(record.assertions.find((a) => a.stepId === "S2")).toMatchObject({
      pass: false,
      actual: "failed",
      by: "alice",
    });
  });

  it("REQ-EXEC-11/AC5: no answer in time, or nobody to ask, is an error (BLOCKED), never a pass", async () => {
    const timeout = await runtimeWith(() => Promise.resolve(undefined)).play();
    expect(timeout.outcome).toBe("error");
    expect(timeout.error).toContain("manual step S2 was not answered");
    expect(timeout.assertions.some((a) => a.stepId === "S2")).toBe(false);
    const nobody = await runtimeWith().play();
    expect(nobody.outcome).toBe("error");
    expect(nobody.error).toContain("needs a person");
  });

  it("REQ-EXEC-11/AC5: a spec that skips a manual step cannot pass", async () => {
    const { runtime } = runtimeWith(() => Promise.resolve(answer()));
    const { step, api, verify } = runtime.context;
    await step("S1", async () => {
      await api.get("/health");
      verify("S1", "status");
    });
    const record = await runtime.finish();
    expect(record.outcome).toBe("error");
    expect(record.error).toContain("manual step S2 was not performed");
  });
});

describe("manual step answers (REQ-EXEC-11/AC3+AC7)", () => {
  it("REQ-EXEC-11/AC7: a text attachment is masked like the note; an answer without a note records none", async () => {
    const record = await runtimeWith(() =>
      Promise.resolve(
        answer({
          attachment: {
            name: "sms log.txt",
            content: new TextEncoder().encode("code 77881 for s3cret-pass"),
          },
        }),
      ),
    ).play();
    const assertion = record.assertions.find((a) => a.stepId === "S2");
    expect(assertion).not.toHaveProperty("note");
    const file = record.evidence.find((e) => e.name === "S2-sms_log.txt");
    expect(file?.content).toBe("code *** for ***");
  });
});
