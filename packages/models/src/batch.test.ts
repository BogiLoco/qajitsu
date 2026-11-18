import type { Experimental_BatchProvider as BatchProvider } from "ai";
import { describe, expect, it } from "vitest";
import { providerBatch } from "./batch.js";

/** A provider batch API in memory: records what was submitted, answers what the test says. */
const fakeProvider = (answer: {
  status?: "pending" | "completed" | "failed";
  items?: unknown[];
  error?: { message: string; code?: string };
}) => {
  const started: unknown[] = [];
  const provider = {
    experimental_batch: () => ({
      specificationVersion: "v4",
      provider: "anthropic.batch",
      supportedUrls: {},
      doStartBatch: (options: unknown) => {
        started.push(options);
        return Promise.resolve({
          batchId: "msgbatch_fictional_1",
          status: "pending",
          expiresAt: "2026-11-19T10:00:00.000Z",
          warnings: [],
        });
      },
      doGetBatchStatus: () =>
        Promise.resolve({
          status: answer.status ?? "completed",
          requestCounts: { total: 1, pending: 0, completed: 1, failed: 0 },
          ...(answer.error ? { error: answer.error } : {}),
        }),
      doGetBatchResults: () =>
        Promise.resolve(
          new ReadableStream({
            start(controller) {
              for (const item of answer.items ?? []) controller.enqueue(item);
              controller.close();
            },
          }),
        ),
    }),
  } as unknown as BatchProvider;
  return { provider, started };
};
const succeeded = (id: string, text: string) => ({
  type: "text",
  id,
  status: "succeeded",
  result: {
    content: [{ type: "text", text }],
    finishReason: { unified: "stop", raw: "end_turn" },
    usage: {
      inputTokens: { total: 1200, noCache: 1000, cacheRead: 200, cacheWrite: 0 },
      outputTokens: { total: 80, text: 80, reasoning: 0 },
    },
    warnings: [],
  },
});

describe("provider batch API (REQ-LLM-12/AC3)", () => {
  it("REQ-LLM-12/AC3: submits the calls with the model, returns a reference that can be stored, reads the answers", async () => {
    const { provider, started } = fakeProvider({ items: [succeeded("audit", '{"findings":[]}')] });
    const batch = providerBatch(provider, "claude-haiku-5");
    expect(batch.priceFactor).toBe(0.5);
    const ref = await batch.submit([
      { id: "audit", system: "You are the auditor.", messages: [{ role: "user", content: "Review TC-01." }] },
    ]);
    expect(ref).toEqual({
      version: 2,
      id: "msgbatch_fictional_1",
      provider: "anthropic.batch",
      expiresAt: "2026-11-19T10:00:00.000Z",
    });
    expect(JSON.stringify(started)).toContain('"modelId":"claude-haiku-5"');
    expect(JSON.stringify(started)).toContain("Review TC-01.");
    // The reference survives JSON (it is stored in the run until the batch is collected).
    const stored = JSON.parse(JSON.stringify(ref)) as typeof ref;
    expect(await batch.status(stored)).toMatchObject({
      state: "completed",
      counts: { total: 1, completed: 1 },
    });
    const answers = await batch.answers(stored);
    expect(answers).toHaveLength(1);
    expect(answers[0]).toMatchObject({ id: "audit", status: "succeeded", text: '{"findings":[]}' });
    expect(answers[0]?.status === "succeeded" ? answers[0].usage.inputTokens : undefined).toBe(1200);
  });

  it("REQ-LLM-12/AC3: a failed batch says why; failed, cancelled and expired calls come back with their reason", async () => {
    const failed = providerBatch(
      fakeProvider({
        status: "failed",
        error: { message: "batch expired before processing", code: "expired" },
      }).provider,
      "gpt-6",
    );
    expect(await failed.status({ version: 2, id: "b", provider: "anthropic.batch" })).toMatchObject({
      state: "failed",
      error: "expired: batch expired before processing",
    });
    const items = providerBatch(
      fakeProvider({
        items: [
          {
            type: "text",
            id: "a",
            status: "failed",
            error: { message: "overloaded", code: "overloaded_error" },
          },
          { type: "text", id: "b", status: "expired" },
        ],
      }).provider,
      "gpt-6",
    );
    expect(await items.answers({ version: 2, id: "b", provider: "anthropic.batch" })).toEqual([
      { id: "a", status: "failed", error: "overloaded_error: overloaded" },
      { id: "b", status: "expired", error: "no reason given" },
    ]);
  });
});
