import { readFileSync } from "node:fs";
import { AdapterError } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, textReply } from "../../../tests/support/fake-fetch.js";
import {
  memoryGatewayCache,
  parseLiteLLMModelInfo,
  parseOpenRouterModels,
  profileWithSources,
  readGateway,
} from "./gateway.js";
import { modelProfile } from "./capabilities.js";

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(new URL(`../../../fixtures/models/${name}`, import.meta.url), "utf8"));
const NOW = new Date("2026-11-17T10:00:00Z");

describe("model profiles from gateways (REQ-LLM-10)", () => {
  it("REQ-LLM-10/AC1: LiteLLM's model info gives each alias its context, features and prices", () => {
    const models = parseLiteLLMModelInfo(fixture("litellm-model-info.json"));
    expect(models.get("strong")).toEqual({
      tools: true,
      vision: true,
      structuredOutput: true,
      contextWindow: 200_000,
      costPerMTok: { input: 3, output: 15, cachedInput: 0.3, cacheWrite: 3.75 },
    });
    expect(models.get("fast")).toMatchObject({ tools: true, vision: true, contextWindow: 128_000 });
    // max_tokens is the output limit: without max_input_tokens the context window stays unknown.
    const outputOnly = parseLiteLLMModelInfo({
      data: [{ model_name: "x", model_info: { max_tokens: 4096 } }],
    });
    expect(outputOnly.get("x")).toEqual({});
    // A model only its own model_info describes: what LiteLLM does not know stays unknown, never assumed.
    expect(models.get("inhouse")).toEqual({ tools: true, vision: false, contextWindow: 64_000 });
  });

  it("REQ-LLM-10/AC1: OpenRouter's model list gives context, tools, structured output, vision and prices", () => {
    const models = parseOpenRouterModels(fixture("openrouter-models.json"));
    expect(models.get("anthropic/claude-sonnet-4.5")).toMatchObject({
      tools: true,
      structuredOutput: true,
      vision: true,
      contextWindow: 1_000_000,
    });
    expect(models.get("anthropic/claude-sonnet-4.5")?.costPerMTok?.input).toBeCloseTo(3, 9);
    expect(models.get("openai/gpt-4o-mini")?.costPerMTok?.output).toBeCloseTo(0.6, 9);
    // A model without tools in its parameters has no tools.
    expect(models.get("inference-net/schematron-v2-turbo")).toMatchObject({ tools: false, vision: false });
  });

  it("REQ-LLM-10/AC2: declared values win over the gateway's; what nobody reports stays unknown, with its source", () => {
    const base = modelProfile("openai-compatible", "inhouse");
    const gateway = parseLiteLLMModelInfo(fixture("litellm-model-info.json")).get("inhouse");
    const { profile, sources } = profileWithSources(base, false, gateway, { context_window: 32_000 });
    expect(profile).toMatchObject({
      tools: true,
      vision: false,
      structuredOutput: false,
      contextWindow: 32_000,
    });
    expect(sources).toEqual({
      tools: "gateway",
      vision: "gateway",
      structuredOutput: "unknown",
      contextWindow: "config",
      price: "unknown",
    });
    // Without a gateway answer the built-in profile (here: none) and the config are all there is.
    const none = profileWithSources(base, false, undefined, undefined);
    expect(none.sources).toEqual({
      tools: "unknown",
      vision: "unknown",
      structuredOutput: "unknown",
      contextWindow: "unknown",
      price: "unknown",
    });
    expect(none.profile.tools).toBe(false);
    // A known model's built-in profile is named as the source where neither gateway nor config says otherwise.
    const claude = profileWithSources(modelProfile("anthropic", "claude-sonnet-5"), true, undefined, {
      vision: false,
    });
    expect(claude.sources).toMatchObject({ tools: "built-in", vision: "config", contextWindow: "built-in" });
  });

  it("REQ-LLM-10/AC3+AC4: the gateway is read once per provider with its time, the key goes to it alone", async () => {
    const key = ["gw", "-", "key", "-", "fictional", "-", "123456"].join("");
    const fake = createFakeFetch([
      { match: /^\/v1\/model\/info$/, reply: jsonReply(fixture("litellm-model-info.json")) },
    ]);
    const cache = memoryGatewayCache();
    const read = () =>
      readGateway(
        { alias: "company", kind: "litellm", baseUrl: "https://litellm.example.test/v1", apiKey: key },
        { fetch: fake.fetch, cache, now: () => NOW },
      );
    const first = await read();
    expect(first.readAt).toBe("2026-11-17T10:00:00.000Z");
    expect(first.models.get("strong")?.contextWindow).toBe(200_000);
    await read();
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.url.origin).toBe("https://litellm.example.test");
    expect(fake.requests[0]?.headers["authorization"]).toBe(`Bearer ${key}`);
    // A cached answer older than a day is read again.
    const later = await readGateway(
      { alias: "company", kind: "litellm", baseUrl: "https://litellm.example.test/v1", apiKey: key },
      { fetch: fake.fetch, cache, now: () => new Date("2026-11-18T11:00:00Z") },
    );
    expect(fake.requests).toHaveLength(2);
    expect(later.readAt).toBe("2026-11-18T11:00:00.000Z");
  });

  it("REQ-LLM-10/AC4: a gateway that does not answer, or answers nonsense, is an error that names no key", async () => {
    const key = ["gw", "-", "key", "-", "fictional", "-", "654321"].join("");
    for (const reply of [
      textReply("unauthorized", 401),
      jsonReply({ unexpected: true }),
      textReply("<html>", 200),
    ]) {
      const fake = createFakeFetch([{ match: /^\/v1\/model\/info$/, reply }]);
      const error = await readGateway(
        { alias: "company", kind: "litellm", baseUrl: "https://litellm.example.test/v1", apiKey: key },
        { fetch: fake.fetch, cache: memoryGatewayCache(), now: () => NOW },
      ).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as Error).message).not.toContain(key);
      expect(JSON.stringify((error as AdapterError).context)).not.toContain(key);
    }
    // A refused connection is named as such.
    const refused = Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
    const down = (() => Promise.reject(refused)) as typeof globalThis.fetch;
    await expect(
      readGateway(
        { alias: "company", kind: "litellm", baseUrl: "https://litellm.example.test/v1", apiKey: key },
        { fetch: down, cache: memoryGatewayCache(), now: () => NOW },
      ),
    ).rejects.toThrow("did not answer: the request failed (ECONNREFUSED).");
    // OpenRouter's list is read from its models endpoint.
    const or = createFakeFetch([
      { match: /^\/api\/v1\/models$/, reply: jsonReply(fixture("openrouter-models.json")) },
    ]);
    const info = await readGateway(
      { alias: "or", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey: key },
      { fetch: or.fetch, cache: memoryGatewayCache(), now: () => NOW },
    );
    expect(info.models.size).toBe(3);
  });

  it("REQ-LLM-10/AC4 + INV-8: an address with credentials or a query, a redirect, or a huge answer is refused; no echo", async () => {
    const key = ["gw", "-", "key", "-", "fictional", "-", "111222"].join("");
    const read = (baseUrl: string, fetch: typeof globalThis.fetch) =>
      readGateway(
        { alias: "company", kind: "litellm", baseUrl, apiKey: key },
        { fetch, cache: memoryGatewayCache(), now: () => NOW },
      ).then(
        () => new Error("no error"),
        (e: unknown) => e as Error,
      );
    const never = (() => Promise.reject(new Error("not called"))) as typeof globalThis.fetch;
    for (const url of [
      "https://user:pa55@gw.example.test/v1",
      "https://gw.example.test/v1?api-key=x",
      "not a url",
    ]) {
      const error = await read(url, never);
      expect(error.message, url).toContain("needs a plain https or http address");
      expect(error.message, url).not.toContain("pa55");
      expect(error.message, url).not.toContain("api-key");
    }
    // The request forbids redirects; an error that quotes the address is not quoted back.
    let init: RequestInit | undefined;
    const redirected = ((_url: string, i: RequestInit) => {
      init = i;
      return Promise.reject(Object.assign(new TypeError("redirect to https://elsewhere.test/?k=secret"), {}));
    }) as unknown as typeof globalThis.fetch;
    const r = await read("https://gw.example.test/v1", redirected);
    expect(init?.redirect).toBe("error");
    expect(r.message).toBe("The litellm gateway company did not answer: the request failed.");
    // A body larger than the cap is not read to the end.
    const huge = createFakeFetch([
      {
        match: /^\/v1\/model\/info$/,
        reply: () => new Response(new Uint8Array(17 * 1024 * 1024).fill(32)),
      },
    ]);
    expect((await read("https://gw.example.test/v1", huge.fetch)).message).toContain("larger than 16 MB");
  });

  it("REQ-LLM-10/AC3: a cached answer read in the future is stale, not kept for ever", async () => {
    const fake = createFakeFetch([
      { match: /^\/v1\/model\/info$/, reply: jsonReply(fixture("litellm-model-info.json")) },
    ]);
    const cache = memoryGatewayCache();
    cache.set("company litellm https://gw.example.test/v1", {
      kind: "litellm",
      readAt: "2099-01-01T00:00:00.000Z",
      models: new Map([["strong", { tools: false }]]),
    });
    const info = await readGateway(
      { alias: "company", kind: "litellm", baseUrl: "https://gw.example.test/v1" },
      { fetch: fake.fetch, cache, now: () => NOW },
    );
    expect(fake.requests).toHaveLength(1);
    expect(info.models.get("strong")?.tools).toBe(true);
  });
});
