import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ROLE_CONTEXT } from "./context-manager.js";
import { AGENT_ROLES } from "./roles.js";

const src = new URL("./", import.meta.url);
const files = readdirSync(src).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
const text = (f: string) => readFileSync(new URL(f, src), "utf8");

describe("every model call goes through the context manager (REQ-CTX-11/AC3, REQ-CTX-13/AC1)", () => {
  it("REQ-CTX-11/AC3: direct model calls prepare their input from an assembled context; only the capability probe is exempt", () => {
    for (const f of files) {
      const calls = (text(f).match(/\bgenerateText\(/g) ?? []).length;
      if (calls === 0 || f === "probe.ts") continue;
      // runStructuredAgent (loop.ts) and the author and healer: every call is prepared from a context, which the type
      // of prepareCall only accepts with its snapshot.
      expect((text(f).match(/prepareCall\(/g) ?? []).length, f).toBeGreaterThanOrEqual(calls);
    }
    // The old fixed-tag helpers are no longer used to build any role's prompt.
    for (const f of files.filter((x) => x !== "context.ts"))
      expect(text(f), f).not.toMatch(/UNTRUSTED_DATA_RULES|renderChangeContext\(/);
  });

  it("REQ-CTX-13/AC1: every agent role declares the kinds of context it may see", () => {
    for (const r of AGENT_ROLES) {
      expect(ROLE_CONTEXT[r.role], r.role).toBeDefined();
    }
    expect(ROLE_CONTEXT["blocked"]).toBeDefined();
    // Judges never see the reasoning of the roles they judge.
    for (const judge of ["auditor", "approver"])
      expect(ROLE_CONTEXT[judge], judge).not.toEqual(expect.arrayContaining(["analysis"]));
    expect(ROLE_CONTEXT["auditor"]).not.toEqual(expect.arrayContaining(["tool-result"]));
  });
});
