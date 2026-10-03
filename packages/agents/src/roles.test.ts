import { describe, expect, it } from "vitest";
import { AGENT_ROLES, missingCapabilities } from "./roles.js";

const auditor = AGENT_ROLES.find((r) => r.role === "auditor")!;
const healer = AGENT_ROLES.find((r) => r.role === "healer")!;

describe("AGENT_ROLES", () => {
  it("never gives an agent a tool that could set a status (REQ-VER-02)", () => {
    for (const role of AGENT_ROLES) {
      expect(role.tools.some((t) => /status|result|verdict/i.test(t))).toBe(false);
    }
  });

  it("keeps the auditor read-only (REQ-VER-06)", () => {
    expect(auditor.tools).not.toContain("write_file");
  });
});

describe("missingCapabilities (REQ-LLM-03)", () => {
  const strong = { tools: true, structuredOutput: true, vision: true, contextWindow: 200_000 };

  it("accepts a model that satisfies the role", () => {
    expect(missingCapabilities(auditor, strong)).toEqual([]);
  });

  it("lists every missing capability", () => {
    const small = { tools: false, structuredOutput: false, vision: false, contextWindow: 8_000 };
    expect(missingCapabilities(auditor, small)).toEqual([
      "tools",
      "structuredOutput",
      "vision",
      "contextWindow>=128000",
    ]);
  });

  it("ignores capabilities a role does not require", () => {
    expect(missingCapabilities(healer, { ...strong, structuredOutput: false, vision: false })).toEqual([]);
  });
});
