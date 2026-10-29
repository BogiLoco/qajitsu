import { readdir, rm } from "node:fs/promises";
import {
  createEventLog,
  fragment,
  parseEventLines,
  type ContextFragment,
  type RunWorkspace,
} from "@qajitsu/core";
import type { ResolvedModel } from "@qajitsu/models";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { scriptedModel } from "../../../tests/support/mock-model.js";
import { createFetchedRun } from "../../../tests/support/run-fixture.js";
import { assembleFor, type AgentStageDeps } from "./roles-run.js";
import type { SummaryPolicy } from "./context-summary.js";
import { createUsageTracker } from "./usage.js";

const f = (over: Partial<Parameters<typeof fragment>[0]> & { text: string }): ContextFragment =>
  fragment({
    kind: "repository",
    source: "x",
    trust: "untrusted",
    section: "varying",
    priority: 50,
    pinned: false,
    ...over,
  });

const fragments = [
  f({
    kind: "role-instructions",
    source: "approver",
    trust: "trusted",
    section: "stable",
    priority: 100,
    pinned: true,
    text: "Judge the plan.",
  }),
  f({ kind: "ticket", source: "ticket/DEMO-1", priority: 85, text: "Discount codes in checkout" }),
  f({ source: "repos/shop/checkout.ts", priority: 60, text: "checkout discount ".repeat(250) }),
  f({ source: "repos/shop/notes.md", priority: 40, text: "checkout notes line\n".repeat(600) }),
  f({ kind: "question", source: "question", trust: "trusted", priority: 0, pinned: true, text: "Decide." }),
];

describe("summaries by a model as the last resort (REQ-CTX-14/AC5, REQ-CTX-17/AC2)", () => {
  let root: string;
  let ws: RunWorkspace;
  let lines: string[];
  beforeEach(async () => {
    ({ root, ws } = await createFetchedRun());
    lines = [];
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const deps = (summary: ResolvedModel, policy: SummaryPolicy): AgentStageDeps => {
    const events = createEventLog({
      ticket: "DEMO-1",
      run: ws.runId,
      write: (l) => lines.push(l),
      now: () => new Date(0),
      mask: (v) => v,
    });
    return {
      ws,
      models: {
        forRole: () => Promise.resolve(summary),
        resolve: () => Promise.reject(new Error("unused")),
      },
      events,
      usage: createUsageTracker({ events }),
      now: () => new Date(0),
      maskJson: (v) => v,
      maskText: (t) => t,
      contextSummaries: policy,
    };
  };

  /** A model that cannot use tools, so it cannot read handles; a 2,000-token budget. */
  const judge = (tools = false) => {
    const m = scriptedModel([{ text: "{}" }], { tools });
    return { ...m, id: "mock/judge", context: { ...m.context, workingRange: 3_000, answerReserve: 1_000 } };
  };

  it("REQ-CTX-14/AC5: for a role that cannot read handles, what the budget left out is summarised, with its model and a handle", async () => {
    const summary = scriptedModel([{ text: JSON.stringify({ summary: "600 lines of checkout notes." }) }]);
    const out = await assembleFor(deps(summary, "no-tools"), {
      stage: "approve",
      role: "approver",
      model: judge(),
      fragments,
    });
    expect(out.prompt).toContain("600 lines of checkout notes.");
    expect(out.prompt).toContain(
      "[summary of repos/shop/notes.md written by mock/scripted; details may be missing]",
    );
    expect(out.prompt).toMatch(
      /<data-[a-z0-9]{12} kind="repository" source="repos\/shop\/notes.md \(summary\)">/,
    );
    const notes = fragments[3];
    expect(out.snapshot.reductions).toContainEqual(
      expect.objectContaining({
        sha256: notes?.sha256,
        action: "summarised",
        reason: expect.stringContaining("summary by mock/scripted; the full text is h-") as unknown,
      }),
    );
    expect(out.snapshot.catalogue.map((c) => c.source)).toEqual(["repos/shop/notes.md"]);
    const events = parseEventLines(lines.join("")).events.map((e) => e.event);
    expect(events).toEqual(["context.snapshot", "model.usage", "context.summarised", "context.snapshot"]);
    // The summary's own input is a separate snapshot of the summary role.
    expect(parseEventLines(lines.join("")).events[0]?.actor.name).toBe("summary");
  });

  it("REQ-CTX-17/AC2: a repeated run uses the cached summary of the same input and model, never a new one", async () => {
    const first = scriptedModel([{ text: JSON.stringify({ summary: "600 lines of checkout notes." }) }]);
    await assembleFor(deps(first, "no-tools"), {
      stage: "approve",
      role: "approver",
      model: judge(),
      fragments,
    });
    expect(await readdir(ws.path("context", "summaries"))).toHaveLength(1);
    const second = scriptedModel([{ text: JSON.stringify({ summary: "something else entirely" }) }]);
    const again = await assembleFor(deps(second, "no-tools"), {
      stage: "approve",
      role: "approver",
      model: judge(),
      fragments,
    });
    expect(second.mock.doGenerateCalls).toHaveLength(0);
    expect(again.prompt).toContain("600 lines of checkout notes.");
    const summarised = parseEventLines(lines.join("")).events.filter((e) => e.event === "context.summarised");
    expect(summarised.map((e) => (e.details as { cached: boolean }).cached)).toEqual([false, true]);
  });

  it("REQ-CTX-14/AC5: no summary for a role that reads handles, with summaries off, or for pinned fragments", async () => {
    const summary = scriptedModel([{ text: JSON.stringify({ summary: "short" }) }]);
    const reads = await assembleFor(deps(summary, "no-tools"), {
      stage: "approve",
      role: "approver",
      model: judge(true),
      fragments,
    });
    expect(reads.snapshot.reductions.some((r) => r.action === "summarised")).toBe(false);
    const off = await assembleFor(deps(summary, "off"), {
      stage: "approve",
      role: "approver",
      model: judge(),
      fragments,
    });
    expect(off.snapshot.reductions.some((r) => r.action === "summarised")).toBe(false);
    expect(summary.mock.doGenerateCalls).toHaveLength(0);
    // `allowed` summarises for every role, but pinned fragments are never shortened.
    const pinnedOnly = [
      fragments[0],
      f({ source: "plan", kind: "repository", pinned: true, priority: 30, text: "plan ".repeat(1_000) }),
      fragments[4],
    ].filter((x): x is ContextFragment => x !== undefined);
    const allowed = await assembleFor(deps(summary, "allowed"), {
      stage: "approve",
      role: "approver",
      model: { ...judge(true), context: { ...judge(true).context, workingRange: 9_000 } },
      fragments: pinnedOnly,
    });
    expect(allowed.snapshot.reductions).toEqual([]);
  });

  it("REQ-CTX-14/AC5: when the summary role fails, the fragment stays behind its handle and the failure is journaled", async () => {
    const broken = scriptedModel([{ text: "not json" }]);
    const out = await assembleFor(deps(broken, "no-tools"), {
      stage: "approve",
      role: "approver",
      model: judge(),
      fragments,
    });
    expect(out.snapshot.reductions.some((r) => r.action === "summarised")).toBe(false);
    expect(out.snapshot.catalogue.map((c) => c.source)).toEqual(["repos/shop/notes.md"]);
    expect(parseEventLines(lines.join("")).events.map((e) => e.event)).toContain("context.summary_failed");
  });
});
