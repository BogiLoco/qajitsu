// Adversarial suite: an environment, or a configuration, that tries to look ready when it is not (REQ-ENV-13,
// invariants 1 and 10).
import { ReadinessConfigSchema, checkReadiness, type ReadinessDeps } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

const CHANGE = "a".repeat(40);
const deps = (
  answer: { status: number; text: string } | Error,
  over: Partial<ReadinessDeps> = {},
): ReadinessDeps => ({
  labels: [],
  repos: [{ alias: "shop", sha: CHANGE }],
  built: false,
  get: () => (answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer)),
  isAncestor: () => Promise.resolve(undefined),
  runScript: () => Promise.resolve({ ok: false, output: "exit 1" }),
  login: () => Promise.resolve(),
  now: () => new Date(0),
  ...over,
});

describe("an environment that is not ready never looks ready (REQ-ENV-13)", () => {
  const config = ReadinessConfigSchema.parse({
    versions: { shop: { url: "/version", sha: "build.sha" } },
    checks: [{ name: "flag", url: "/flags", json: "enabled", equals: true }],
  });

  it("invariant 1 + REQ-ENV-13/AC1: unreadable, malformed or look-alike versions are not ready", async () => {
    for (const answer of [
      new Error("ECONNREFUSED"),
      { status: 500, text: "{}" },
      { status: 200, text: "<html>ok</html>" },
      { status: 200, text: JSON.stringify({ build: { sha: 1234 } }) },
      // The commit as a prefix, or on another path, is not the deployed commit.
      { status: 200, text: JSON.stringify({ build: { sha: CHANGE.slice(0, 12) } }) },
      { status: 200, text: JSON.stringify({ sha: CHANGE }) },
    ])
      expect((await checkReadiness(config, deps(answer))).ready, JSON.stringify(answer)).toBe(false);
  });

  it("invariant 1 + REQ-ENV-13/AC2: a check that looks alike is not ready: a truthy string, a redirect, a failing script", async () => {
    const answers: Record<string, { status: number; text: string }> = {
      "/version": { status: 200, text: JSON.stringify({ build: { sha: CHANGE } }) },
      "/flags": { status: 200, text: JSON.stringify({ enabled: "true" }) },
    };
    const get = (target: string) => Promise.resolve(answers[target] ?? { status: 302, text: "" });
    expect((await checkReadiness(config, deps(new Error("unused"), { get }))).ready).toBe(false);
    const script = ReadinessConfigSchema.parse({
      checks: [{ name: "migrations", command: "hooks/migrations.mjs" }],
    });
    expect((await checkReadiness(script, deps(new Error("unused")))).ready).toBe(false);
  });

  it("REQ-ENV-13/AC5: only a person running the command can override; the configuration has no way to", () => {
    expect(() => ReadinessConfigSchema.parse({ override: { reason: "always" } })).toThrow();
    expect(() => ReadinessConfigSchema.parse({ checks: [{ name: "x", url: "/x", ok: true }] })).toThrow();
  });
});
