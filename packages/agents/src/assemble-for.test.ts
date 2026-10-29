import { createEventLog, fragment } from "@qajitsu/core";
import { contextProfile } from "@qajitsu/models";
import { describe, expect, it } from "vitest";
import { assembleFor, type AgentStageDeps } from "./roles-run.js";

const f = (over: Partial<Parameters<typeof fragment>[0]> & { text: string }) =>
  fragment({
    kind: "repository",
    source: "x",
    trust: "untrusted",
    section: "varying",
    priority: 50,
    pinned: false,
    ...over,
  });

describe("assembling a call for a model (REQ-CTX-14, REQ-LLM-15, REQ-CTX-12/AC4)", () => {
  it("REQ-LLM-15/AC2 + REQ-CTX-14/AC1: the model's profile gives the budget; near it the provider's count decides", async () => {
    const lines: string[] = [];
    const events = createEventLog({
      ticket: "DEMO-1",
      run: "r",
      write: (line) => lines.push(line),
      now: () => new Date(0),
      mask: (v) => v,
    });
    const deps = { events } as unknown as AgentStageDeps;
    const fragments = [
      f({
        kind: "role-instructions",
        source: "planner",
        trust: "trusted",
        section: "stable",
        priority: 100,
        pinned: true,
        text: "Plan.",
      }),
      f({ kind: "ticket", source: "ticket/DEMO-1", priority: 85, text: "Discount codes in checkout" }),
      f({ source: "repos/shop/checkout.ts", text: "checkout discount ".repeat(400) }),
      f({
        kind: "knowledge",
        source: "knowledge/other.md",
        priority: 40,
        text: "unrelated words here ".repeat(115),
      }),
      f({
        kind: "question",
        source: "question",
        trust: "trusted",
        priority: 0,
        pinned: true,
        text: "Write the plan.",
      }),
    ];
    // A window that fits everything by the estimate; the provider counts more than the budget allows.
    const model = {
      id: "claude/c",
      context: {
        ...contextProfile("anthropic", { contextWindow: 8_000 }),
        workingRange: 6_000,
        answerReserve: 2_000,
        style: "full" as const,
      },
      countTokens: () => Promise.resolve(5_000),
    };
    const out = await assembleFor(deps, { stage: "plan", role: "probe-test", model, fragments });
    expect(out.snapshot.budget?.counting).toBe("provider");
    expect(out.snapshot.budget?.tokens).toBeLessThan(4_000);
    expect(out.snapshot.catalogue.map((c) => c.source)).toEqual(["knowledge/other.md"]);
    // REQ-CTX-12/AC4: the catalogue comes with its tools, and reading is journaled.
    const read = out.tools?.find((t) => t.name === "read_context");
    const handle = out.snapshot.catalogue[0]?.handle ?? "";
    expect(await read?.execute({ handle })).toContain("unrelated words here");
    expect(
      await out.tools?.find((t) => t.name === "search_context")?.execute({ question: "unrelated words" }),
    ).toContain(handle);
    const journal = lines.map((l) => (JSON.parse(l) as { event: string }).event);
    expect(journal).toEqual(["context.snapshot", "context.read", "context.search"]);
    // Without a catalogue there are no tools to offer.
    const small = await assembleFor(deps, {
      stage: "plan",
      role: "probe-test",
      model: { id: "m" },
      fragments: fragments.slice(0, 2),
    });
    expect(small.tools).toEqual([]);
  });
});
