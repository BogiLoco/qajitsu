// Tests found missing by mutation testing (REQ-NFR-14): each kills mutants of guard that the earlier tests let live.
import { describe, expect, it } from "vitest";
import { JOURNAL_MAX_STRING, createJournal } from "./journal.js";
import { DEFAULT_PROTECTED_PATHS, evaluateToolCall, type GuardPolicy } from "./policy.js";

const root = "/runs/SHOP-1/20261003-1046-k7f3";
const policy: GuardPolicy = {
  workspaceRoot: root,
  allowedTools: new Set(["read_file", "write_file", "move_file", "browser_navigate", "note"]),
  writeTools: new Set(["write_file", "move_file"]),
  readTools: new Set(["read_file"]),
  protectedPaths: DEFAULT_PROTECTED_PATHS,
  networkTools: new Set(["browser_navigate"]),
  allowedOrigins: ["https://staging.example.com"],
};

describe("guard decisions, every branch and its reason (REQ-VER-03, REQ-NFR-14)", () => {
  it.each(DEFAULT_PROTECTED_PATHS.map((p) => [p]))("REQ-VER-03: %s is written only by QAJitsu", (p) => {
    const path = p.endsWith("/") ? `${p}x.json` : p;
    expect(evaluateToolCall({ tool: "write_file", input: { path } }, policy)).toEqual({
      allowed: false,
      code: "PROTECTED_PATH",
      reason: `'${path}' is written only by runners and QAJitsu itself.`,
    });
  });

  it("REQ-VER-03: the reasons name the field, the path, the tool and the origin", () => {
    expect(evaluateToolCall({ tool: "write_file", input: { path: "" } }, policy)).toEqual({
      allowed: false,
      code: "MISSING_PATH",
      reason: "Tool input 'path' must be a non-empty path.",
    });
    expect(evaluateToolCall({ tool: "move_file", input: { path: "specs/a.ts", to: "" } }, policy)).toEqual({
      allowed: false,
      code: "MISSING_PATH",
      reason: "Tool input 'to' must be a non-empty path.",
    });
    expect(evaluateToolCall({ tool: "write_file", input: { path: "../x" } }, policy)).toEqual({
      allowed: false,
      code: "OUTSIDE_WORKSPACE",
      reason: "Path '../x' is outside the run workspace.",
    });
    expect(evaluateToolCall({ tool: "set_status", input: {} }, policy)).toEqual({
      allowed: false,
      code: "UNKNOWN_TOOL",
      reason: "Tool 'set_status' is not available in this stage.",
    });
    expect(evaluateToolCall({ tool: "browser_navigate", input: { url: 7 } }, policy)).toEqual({
      allowed: false,
      code: "URL_NOT_ALLOWED",
      reason: "Tool input 'url' must be a string.",
    });
    expect(evaluateToolCall({ tool: "browser_navigate", input: { url: "not a url" } }, policy)).toEqual({
      allowed: false,
      code: "URL_NOT_ALLOWED",
      reason: "'not a url' is not a valid URL.",
    });
    expect(
      evaluateToolCall({ tool: "browser_navigate", input: { url: "https://shop.example.com/x" } }, policy),
    ).toEqual({
      allowed: false,
      code: "URL_NOT_ALLOWED",
      reason: "Origin 'https://shop.example.com' is not on the environment allowlist.",
    });
  });

  it("REQ-PRJ-04/AC1: a read tool may not read outside the run; another tool's path field is not a read", () => {
    expect(evaluateToolCall({ tool: "read_file", input: { path: "/etc/passwd" } }, policy)).toEqual({
      allowed: false,
      code: "OUTSIDE_WORKSPACE",
      reason: "Path '/etc/passwd' is outside the run workspace.",
    });
    // `note` is neither a write nor a read tool: its path is data, not a file it opens.
    expect(evaluateToolCall({ tool: "note", input: { path: "/etc/passwd" } }, policy).allowed).toBe(true);
    // A read tool without a path is not path-checked here; the tool itself refuses it.
    expect(evaluateToolCall({ tool: "read_file", input: { path: 42 } }, policy).allowed).toBe(true);
  });

  it("REQ-VER-03: a protected folder covers itself and what is in it, but not a longer name", () => {
    expect(evaluateToolCall({ tool: "write_file", input: { path: "manual" } }, policy).allowed).toBe(false);
    expect(evaluateToolCall({ tool: "write_file", input: { path: "manuals/x.md" } }, policy).allowed).toBe(
      true,
    );
    expect(
      evaluateToolCall({ tool: "write_file", input: { path: "Results/TC-01.json" } }, policy).allowed,
    ).toBe(false);
  });
});

describe("protected entries (REQ-VER-03, REQ-NFR-14)", () => {
  it("REQ-VER-03: an entry without a trailing slash protects that file only, not names that start with it", () => {
    const only = { ...policy, protectedPaths: ["notes.md"] };
    expect(evaluateToolCall({ tool: "write_file", input: { path: "notes.md" } }, only).allowed).toBe(false);
    expect(evaluateToolCall({ tool: "write_file", input: { path: "notes.md.bak" } }, only).allowed).toBe(
      true,
    );
    expect(evaluateToolCall({ tool: "write_file", input: { path: "notes.m" } }, only).allowed).toBe(true);
  });
});

describe("the tool-call journal (REQ-VER-04/AC2, REQ-NFR-14)", () => {
  const journal = () => {
    const lines: string[] = [];
    const j = createJournal(
      (l) => lines.push(l),
      () => new Date("2026-11-20T10:00:00Z"),
      (v) =>
        typeof v === "string"
          ? v.replaceAll("s3cret", "***")
          : JSON.parse(JSON.stringify(v).replaceAll("s3cret", "***")),
    );
    return { j, line: () => JSON.parse(lines.at(-1) ?? "{}") as Record<string, unknown> };
  };

  it("REQ-VER-04/AC2: a string of exactly the limit is kept; one longer is cut and says how long it was", () => {
    const { j, line } = journal();
    const exact = "a".repeat(JOURNAL_MAX_STRING);
    j.record({ run: "r", stage: "author", event: "tool_allowed", tool: "t", args: { text: exact } });
    expect((line()["args"] as { text: string }).text).toBe(exact);
    j.record({ run: "r", stage: "author", event: "tool_allowed", tool: "t", args: { text: `${exact}b` } });
    expect((line()["args"] as { text: string }).text).toBe(
      `${exact}…(${String(JOURNAL_MAX_STRING + 1)} chars)`,
    );
  });

  it("REQ-VER-04/AC2: nested arrays and objects are walked; other values stay as they are", () => {
    const { j, line } = journal();
    const long = "x".repeat(JOURNAL_MAX_STRING + 10);
    j.record({
      run: "r",
      stage: "author",
      event: "tool_allowed",
      tool: "t",
      args: { list: [long, 7, null, true], nested: { deep: [{ s: long }] } },
    });
    const args = line()["args"] as { list: unknown[]; nested: { deep: { s: string }[] } };
    expect(String(args.list[0])).toMatch(/…\(510 chars\)$/);
    expect(args.list.slice(1)).toEqual([7, null, true]);
    expect(args.nested.deep[0]?.s).toMatch(/…\(510 chars\)$/);
  });

  it("REQ-VER-04/AC2 + INV-8: a denial's reason is masked; a call without one has none", () => {
    const { j, line } = journal();
    j.record({
      run: "r",
      stage: "author",
      event: "tool_denied",
      tool: "t",
      code: "X",
      reason: "token s3cret refused",
    });
    expect(line()["reason"]).toBe("token *** refused");
    j.record({ run: "r", stage: "author", event: "tool_allowed", tool: "t" });
    expect("reason" in line()).toBe(false);
  });
});
