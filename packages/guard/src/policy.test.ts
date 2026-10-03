import { describe, expect, it } from "vitest";
import { DEFAULT_PROTECTED_PATHS, evaluateToolCall, resolveInWorkspace, type GuardPolicy } from "./policy.js";

const policy: GuardPolicy = {
  workspaceRoot: "/runs/SHOP-1/20261003-1046-k7f3",
  allowedTools: new Set(["read_file", "write_file", "move_file", "browser_navigate"]),
  writeTools: new Set(["write_file", "move_file"]),
  protectedPaths: DEFAULT_PROTECTED_PATHS,
  networkTools: new Set(["browser_navigate"]),
  allowedOrigins: ["https://staging.example.com"],
};

describe("evaluateToolCall (REQ-VER-03)", () => {
  it("allows writing generated specs", () => {
    expect(evaluateToolCall({ tool: "write_file", input: { path: "specs/TC-01.spec.ts" } }, policy)).toEqual({
      allowed: true,
    });
  });

  it("denies tools not available in the stage", () => {
    const decision = evaluateToolCall({ tool: "set_status", input: {} }, policy);
    expect(decision).toMatchObject({ allowed: false, code: "UNKNOWN_TOOL" });
  });

  it.each([
    "results/TC-01.json",
    "evidence/manifest.json",
    "plan/plan.approved.yaml",
    "journal/events.jsonl",
    "run.json",
    "results",
  ])("denies writing protected path %s", (path) => {
    expect(evaluateToolCall({ tool: "write_file", input: { path } }, policy)).toMatchObject({
      allowed: false,
      code: "PROTECTED_PATH",
    });
  });

  it("does not treat similarly named paths as protected", () => {
    expect(
      evaluateToolCall({ tool: "write_file", input: { path: "results-notes.md" } }, policy).allowed,
    ).toBe(true);
    expect(
      evaluateToolCall({ tool: "write_file", input: { path: "plan/plan.v2.yaml" } }, policy).allowed,
    ).toBe(true);
  });

  it.each(["../other-run/results/x.json", "/etc/passwd", "specs/../../x", "..\\..\\x"])(
    "denies escaping the workspace: %s",
    (path) => {
      expect(evaluateToolCall({ tool: "write_file", input: { path } }, policy)).toMatchObject({
        allowed: false,
        code: "OUTSIDE_WORKSPACE",
      });
    },
  );

  it("allows absolute paths inside the workspace", () => {
    const path = "/runs/SHOP-1/20261003-1046-k7f3/specs/a.ts";
    expect(evaluateToolCall({ tool: "write_file", input: { path } }, policy).allowed).toBe(true);
  });

  it("denies missing or non-string paths", () => {
    expect(evaluateToolCall({ tool: "write_file", input: {} }, policy)).toMatchObject({
      code: "MISSING_PATH",
    });
    expect(evaluateToolCall({ tool: "write_file", input: { path: 42 } }, policy)).toMatchObject({
      code: "MISSING_PATH",
    });
  });

  it("checks the destination of moves", () => {
    const decision = evaluateToolCall(
      { tool: "move_file", input: { path: "specs/a.json", to: "results/a.json" } },
      policy,
    );
    expect(decision).toMatchObject({ allowed: false, code: "PROTECTED_PATH" });
    expect(
      evaluateToolCall({ tool: "move_file", input: { path: "specs/a.ts", to: "specs/b.ts" } }, policy)
        .allowed,
    ).toBe(true);
  });

  it("does not path-check read tools", () => {
    expect(
      evaluateToolCall({ tool: "read_file", input: { path: "results/TC-01.json" } }, policy).allowed,
    ).toBe(true);
  });
});

describe("URL allowlist (REQ-ENV-01, invariant 10)", () => {
  it("allows allowlisted origins", () => {
    const call = { tool: "browser_navigate", input: { url: "https://staging.example.com/cart" } };
    expect(evaluateToolCall(call, policy).allowed).toBe(true);
  });

  it.each(["https://shop.example.com/", "http://staging.example.com/", "not a url", 7])(
    "denies %s",
    (url) => {
      expect(evaluateToolCall({ tool: "browser_navigate", input: { url } }, policy)).toMatchObject({
        allowed: false,
        code: "URL_NOT_ALLOWED",
      });
    },
  );
});

describe("resolveInWorkspace", () => {
  it("returns an empty string for the root itself", () => {
    expect(resolveInWorkspace("/w", ".")).toBe("");
  });
  it("normalises Windows separators", () => {
    expect(resolveInWorkspace("C:\\w", "specs\\a.ts")).toBe("specs/a.ts");
  });
});
