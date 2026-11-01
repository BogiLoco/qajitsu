import { parseProjectConfig } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createTestDataProvider, type DataHookRunner } from "./test-data.js";

const config = (testData: unknown) =>
  parseProjectConfig({
    project: "demo",
    jira: { type: "file", tickets_dir: "t", project_key: "DEMO" },
    test_data: testData,
  }).test_data!;

const api = {
  kinds: {
    product: {
      create: { request: "POST /admin/products", as: "user:admin", id: "product.id" },
      remove: { request: "DELETE /admin/products/{id}", as: "user:admin" },
    },
  },
  cleanup: { request: "DELETE /admin/products?marker={marker}", as: "user:admin" },
};

const fakeFetch = (respond: (method: string, url: string, body: unknown) => Response) => {
  const calls: { method: string; url: string; headers: Record<string, string>; body: unknown }[] = [];
  const fetch = ((input: URL | string, init?: RequestInit) => {
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : undefined;
    const call = {
      method: init?.method ?? "GET",
      url: input.toString(),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body,
    };
    calls.push(call);
    return Promise.resolve(respond(call.method, call.url, body));
  }) as typeof globalThis.fetch;
  return { fetch, calls };
};

const provider = (testData: unknown, fetch: typeof globalThis.fetch, runHook?: DataHookRunner) =>
  createTestDataProvider({
    config: config(testData),
    baseUrl: "http://127.0.0.1:3477",
    allowedOrigins: ["http://127.0.0.1:3477"],
    fetch,
    headersFor: (alias) =>
      Promise.resolve(alias === "user:admin" ? { authorization: "Bearer admin-token" } : {}),
    qaDir: "/project/.qa",
    ...(runHook ? { runHook } : {}),
  });

describe("test data through the application's API or the data hook (REQ-EXEC-53)", () => {
  it("REQ-EXEC-53/AC1+AC2: a record is created as the configured account with the marker and removed by its id", async () => {
    const { fetch, calls } = fakeFetch((method) =>
      method === "POST"
        ? new Response(JSON.stringify({ product: { id: "P-9", name: "Lamp", stock: 3 } }), { status: 201 })
        : new Response(null, { status: 204 }),
    );
    const p = provider(api, fetch);
    const rec = await p.create({
      name: "lamp",
      kind: "product",
      with: { name: "Lamp", stock: 3 },
      marker: "qj-DEMO-17-r-TC-01-a1",
    });
    expect(rec).toEqual({
      name: "lamp",
      kind: "product",
      id: "P-9",
      record: { product: { id: "P-9", name: "Lamp", stock: 3 } },
    });
    expect(calls[0]).toMatchObject({
      method: "POST",
      url: "http://127.0.0.1:3477/admin/products",
      headers: { authorization: "Bearer admin-token", "content-type": "application/json" },
      body: { name: "Lamp", stock: 3, qa_marker: "qj-DEMO-17-r-TC-01-a1" },
    });
    await p.remove(rec, "qj-DEMO-17-r-TC-01-a1");
    expect(calls[1]).toMatchObject({ method: "DELETE", url: "http://127.0.0.1:3477/admin/products/P-9" });
    expect(await p.cleanup("qj-DEMO-17-")).toBeUndefined();
    expect(calls[2]?.url).toBe("http://127.0.0.1:3477/admin/products?marker=qj-DEMO-17-");
  });

  it("REQ-EXEC-53/AC3: a refused request, an answer without an id or a kind nobody handles is an error with the reason", async () => {
    const refused = provider(
      api,
      fakeFetch(() => new Response('{"error":"FORBIDDEN"}', { status: 403 })).fetch,
    );
    await expect(refused.create({ name: "lamp", kind: "product", with: {}, marker: "m" })).rejects.toThrow(
      'POST /admin/products answered 403: {"error":"FORBIDDEN"}',
    );
    const noId = provider(api, fakeFetch(() => new Response("{}", { status: 201 })).fetch);
    await expect(noId.create({ name: "lamp", kind: "product", with: {}, marker: "m" })).rejects.toThrow(
      "the answer for lamp has no id at product.id",
    );
    await expect(noId.create({ name: "x", kind: "coupon", with: {}, marker: "m" })).rejects.toThrow(
      "has no API in test_data.kinds and the project has no test_data.hook",
    );
    // A record already gone counts as removed.
    const gone = provider(api, fakeFetch(() => new Response("", { status: 404 })).fetch);
    await expect(
      gone.remove({ name: "lamp", kind: "product", id: "P-1", record: {} }, "m"),
    ).resolves.toBeUndefined();
  });

  it("invariant 10: test data never goes to an origin outside the environment's allowlist", async () => {
    const { fetch, calls } = fakeFetch(() => new Response("{}", { status: 201 }));
    const p = provider(
      { kinds: { product: { create: { request: "POST //evil.example.com/collect" } } } },
      fetch,
    );
    await expect(p.create({ name: "lamp", kind: "product", with: {}, marker: "m" })).rejects.toThrow(
      "http://evil.example.com is not an allowed origin",
    );
    expect(calls).toEqual([]);
  });

  it("REQ-EXEC-53/AC1: kinds without an API go to the data hook with a JSON request; its last line is the answer", async () => {
    const requests: unknown[] = [];
    const runHook: DataHookRunner = (script, request, env) => {
      requests.push({ script, request, env });
      return Promise.resolve(
        `log line\n${JSON.stringify({ id: 42, record: { code: "SAVE5" }, removed: 3 })}\n`,
      );
    };
    const p = provider({ hook: "hooks/data.mjs" }, fakeFetch(() => new Response()).fetch, runHook);
    const rec = await p.create({ name: "code", kind: "coupon", with: { percent: 5 }, marker: "qj-m" });
    expect(rec).toEqual({ name: "code", kind: "coupon", id: "42", record: { code: "SAVE5" } });
    await p.remove(rec, "qj-m");
    expect(await p.cleanup("qj-")).toBe(3);
    expect(requests).toEqual([
      {
        script: "/project/.qa/hooks/data.mjs",
        request: {
          action: "create",
          name: "code",
          kind: "coupon",
          with: { percent: 5, qa_marker: "qj-m" },
          marker: "qj-m",
        },
        env: { BASE_URL: "http://127.0.0.1:3477", QAJITSU_MARKER: "qj-m" },
      },
      expect.objectContaining({
        request: { action: "remove", name: "code", kind: "coupon", id: "42", marker: "qj-m" },
      }),
      expect.objectContaining({
        request: { action: "cleanup", prefix: "qj-" },
        env: expect.objectContaining({ QAJITSU_MARKER: "qj-" }) as unknown,
      }),
    ]);
    const broken = provider({ hook: "hooks/data.mjs" }, fakeFetch(() => new Response()).fetch, () =>
      Promise.resolve("not json"),
    );
    await expect(broken.create({ name: "x", kind: "coupon", with: {}, marker: "m" })).rejects.toThrow(
      "the data hook's last line is not a JSON object",
    );
  });

  it("REQ-EXEC-53: the config refuses a hook outside .qa/hooks and requests without their placeholders", () => {
    expect(() => config({ hook: "../evil.mjs" })).toThrow();
    expect(() => config({ kinds: { product: { create: { request: "GET /x" } } } })).toThrow();
    expect(() =>
      config({ kinds: { product: { create: { request: "POST /x" }, remove: { request: "DELETE /x" } } } }),
    ).toThrow();
    expect(() => config({ cleanup: { request: "DELETE /x" } })).toThrow();
  });
});
