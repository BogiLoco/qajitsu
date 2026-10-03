import { describe, expect, it } from "vitest";
import { createGuard } from "./guard.js";
import { createJournal } from "./journal.js";
import { DEFAULT_PROTECTED_PATHS, type GuardPolicy } from "./policy.js";

const policy: GuardPolicy = {
  workspaceRoot: "/runs/r",
  allowedTools: new Set(["write_file"]),
  writeTools: new Set(["write_file"]),
  protectedPaths: DEFAULT_PROTECTED_PATHS,
  networkTools: new Set(),
  allowedOrigins: [],
};

function setup() {
  const lines: string[] = [];
  const journal = createJournal(
    (line) => lines.push(line),
    () => new Date("2026-10-03T10:46:00.000Z"),
  );
  const guard = createGuard({ run: "20261003-1046-k7f3", stage: "author", policy, journal });
  const events = () => lines.map((l) => JSON.parse(l) as Record<string, unknown>);
  return { guard, lines, events };
}

describe("createGuard (REQ-VER-04)", () => {
  it("journals allowed calls", () => {
    const { guard, events } = setup();
    guard.check({ tool: "write_file", input: { path: "specs/a.ts" } });
    expect(events()).toEqual([
      {
        ts: "2026-10-03T10:46:00.000Z",
        run: "20261003-1046-k7f3",
        stage: "author",
        event: "tool_allowed",
        tool: "write_file",
      },
    ]);
  });

  it("journals denied calls with code and reason", () => {
    const { guard, events } = setup();
    const decision = guard.check({ tool: "write_file", input: { path: "results/a.json" } });
    expect(decision.allowed).toBe(false);
    expect(events()[0]).toMatchObject({ event: "tool_denied", code: "PROTECTED_PATH" });
  });

  it("writes one JSON object per line", () => {
    const { guard, lines } = setup();
    guard.check({ tool: "write_file", input: { path: "specs/a.ts" } });
    guard.check({ tool: "nope", input: {} });
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => l.endsWith("\n"))).toBe(true);
  });
});
