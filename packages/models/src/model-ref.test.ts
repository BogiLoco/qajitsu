import { ConfigError } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { parseModelRef, resolveRoleModel } from "./model-ref.js";

describe("parseModelRef (REQ-LLM-01)", () => {
  it.each([
    ["anthropic/claude-sonnet-5", { provider: "anthropic", model: "claude-sonnet-5" }],
    ["company/strong", { provider: "company", model: "strong" }],
    ["local/qwen2.5-coder:32b", { provider: "local", model: "qwen2.5-coder:32b" }],
    ["openrouter/meta/llama-4", { provider: "openrouter", model: "meta/llama-4" }],
  ])("parses %s", (reference, expected) => {
    expect(parseModelRef(reference)).toEqual(expected);
  });

  it.each(["strong", "/model", "Company/strong", "local/", "local/has space"])("rejects %s", (reference) => {
    expect(() => parseModelRef(reference)).toThrow(ConfigError);
  });
});

describe("resolveRoleModel (REQ-LLM-02)", () => {
  const roles = { author: "company/strong", default: "local/small" };

  it("uses the role entry", () => {
    expect(resolveRoleModel(roles, "author")).toEqual({ provider: "company", model: "strong" });
  });

  it("falls back to default", () => {
    expect(resolveRoleModel(roles, "summary")).toEqual({ provider: "local", model: "small" });
  });

  it("fails when nothing is configured", () => {
    expect(() => resolveRoleModel({}, "auditor")).toThrow(/auditor/);
  });
});
