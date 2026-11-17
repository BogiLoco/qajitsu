import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fileGatewayCache } from "./gateway-cache.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const file = () => {
  const d = mkdtempSync(join(tmpdir(), "qj-gw-"));
  dirs.push(d);
  return join(d, "cache", "gateways.json");
};

describe("the gateway cache of a project (REQ-LLM-10/AC3)", () => {
  it("REQ-LLM-10/AC3: a gateway's models are kept with their read time between commands", () => {
    const path = file();
    const info = {
      kind: "litellm" as const,
      readAt: "2026-11-17T10:00:00.000Z",
      models: new Map([["strong", { tools: true, contextWindow: 200_000 }]]),
    };
    fileGatewayCache(path).set("company litellm https://gw/v1", info);
    const again = fileGatewayCache(path).get("company litellm https://gw/v1");
    expect(again?.readAt).toBe(info.readAt);
    expect(again?.models.get("strong")).toEqual({ tools: true, contextWindow: 200_000 });
    expect(fileGatewayCache(path).get("other")).toBeUndefined();
    // Only what the gateway reported is stored.
    expect(readFileSync(path, "utf8")).not.toMatch(/key|token|authorization/i);
  });

  it("REQ-LLM-10/AC4: a broken cache file is an empty cache, never an error", () => {
    const path = file();
    fileGatewayCache(path).set("k", {
      kind: "openrouter",
      readAt: "2026-11-17T10:00:00.000Z",
      models: new Map(),
    });
    writeFileSync(path, "{not json");
    expect(fileGatewayCache(path).get("k")).toBeUndefined();
    writeFileSync(path, JSON.stringify({ k: { kind: "litellm", readAt: 5, models: "x" } }));
    expect(fileGatewayCache(path).get("k")).toBeUndefined();
    // A planted entry with another shape (a price below zero, an unknown field, an unknown kind) is not used.
    for (const planted of [
      {
        kind: "litellm",
        readAt: "2026-11-17T10:00:00.000Z",
        models: [["x", { costPerMTok: { input: -1, output: 0 } }]],
      },
      { kind: "litellm", readAt: "2026-11-17T10:00:00.000Z", models: [["x", { tools: true, admin: true }]] },
      { kind: "bedrock", readAt: "2026-11-17T10:00:00.000Z", models: [] },
    ]) {
      writeFileSync(path, JSON.stringify({ k: planted }));
      expect(fileGatewayCache(path).get("k"), JSON.stringify(planted)).toBeUndefined();
    }
    writeFileSync(
      path,
      JSON.stringify({ k: { kind: "litellm", readAt: "2026-11-17T10:00:00.000Z", models: [] } }),
    );
    expect(fileGatewayCache(path).get("__proto__")).toBeUndefined();
    expect(fileGatewayCache(path).get("k")?.kind).toBe("litellm");
  });
});
