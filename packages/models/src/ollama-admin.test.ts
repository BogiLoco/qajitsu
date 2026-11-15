import { AdapterError } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, textReply } from "../../../tests/support/fake-fetch.js";
import { ollamaPull, ollamaTags } from "./ollama-admin.js";

const BASE = "http://ollama:11434";
const DIGEST = "a".repeat(64);
const ndjson = (...lines: unknown[]) => lines.map((l) => JSON.stringify(l)).join("\n") + "\n";

describe("Ollama administration for the stack (REQ-GEN-10)", () => {
  it("REQ-GEN-10/AC3: ollamaPull streams /api/pull to success", async () => {
    const fake = createFakeFetch([
      {
        method: "POST",
        match: /^\/api\/pull$/,
        reply: textReply(
          ndjson(
            { status: "pulling manifest" },
            { status: "downloading", completed: 5, total: 10 },
            { status: "success" },
          ),
        ),
      },
    ]);
    await expect(ollamaPull(BASE, "qwen3:4b", fake.fetch)).resolves.toBeUndefined();
    expect(fake.requests).toHaveLength(1);
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({ model: "qwen3:4b", stream: true });
    // The `/api` form of the base URL is accepted too.
    await ollamaPull(`${BASE}/api/`, "qwen3:4b", fake.fetch);
    expect(fake.requests[1]?.url.pathname).toBe("/api/pull");
  });

  it("REQ-GEN-10/AC3: ollamaPull fails with the model name on an error line or an HTTP error", async () => {
    const errorLine = createFakeFetch([
      {
        method: "POST",
        match: /^\/api\/pull$/,
        reply: textReply(
          ndjson({ status: "pulling manifest" }, { error: "pull model manifest: file does not exist" }),
        ),
      },
    ]);
    const thrown = await ollamaPull(BASE, "no-such-model:1b", errorLine.fetch).catch((e: unknown) => e);
    expect(thrown).toBeInstanceOf(AdapterError);
    expect((thrown as AdapterError).code).toBe("OLLAMA_PULL_FAILED");
    expect((thrown as AdapterError).message).toContain("no-such-model:1b");
    expect((thrown as AdapterError).message).toContain("file does not exist");
    expect((thrown as AdapterError).context).toMatchObject({ model: "no-such-model:1b" });

    const http = createFakeFetch([{ method: "POST", match: /^\/api\/pull$/, reply: textReply("boom", 500) }]);
    await expect(ollamaPull(BASE, "qwen3:4b", http.fetch)).rejects.toThrow(/qwen3:4b.*HTTP 500/);

    // A stream that ends without "success" is not a pull that worked.
    const cut = createFakeFetch([
      { method: "POST", match: /^\/api\/pull$/, reply: textReply(ndjson({ status: "downloading" })) },
    ]);
    await expect(ollamaPull(BASE, "qwen3:4b", cut.fetch)).rejects.toThrow(/qwen3:4b.*ended before success/);

    const down = (() => Promise.reject(new TypeError("fetch failed"))) as typeof globalThis.fetch;
    await expect(ollamaPull(BASE, "qwen3:4b", down)).rejects.toThrow(/qwen3:4b.*fetch failed/);
  });

  it("REQ-GEN-10/AC4: ollamaTags returns the name and the sha256 digest of each local model", async () => {
    const fake = createFakeFetch([
      {
        match: /^\/api\/tags$/,
        reply: jsonReply({
          models: [
            { name: "qwen3:4b", model: "qwen3:4b", digest: DIGEST, size: 1 },
            { name: "nomic-embed-text:latest", digest: `sha256:${"b".repeat(64)}` },
          ],
        }),
      },
    ]);
    expect(await ollamaTags(BASE, fake.fetch)).toEqual([
      { name: "qwen3:4b", digest: `sha256:${DIGEST}` },
      { name: "nomic-embed-text:latest", digest: `sha256:${"b".repeat(64)}` },
    ]);
  });

  it("REQ-GEN-10/AC4: an answer that is not a list of models with digests is an error, never an empty list", async () => {
    for (const body of [
      {},
      { models: [{ name: "qwen3:4b" }] },
      { models: [{ name: "x", digest: "short" }] },
    ]) {
      const fake = createFakeFetch([{ match: /^\/api\/tags$/, reply: jsonReply(body) }]);
      await expect(ollamaTags(BASE, fake.fetch), JSON.stringify(body)).rejects.toBeInstanceOf(AdapterError);
    }
    const http = createFakeFetch([{ match: /^\/api\/tags$/, reply: textReply("no", 503) }]);
    await expect(ollamaTags(BASE, http.fetch)).rejects.toThrow(/HTTP 503/);
  });
});
