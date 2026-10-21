import { describe, expect, it } from "vitest";
import { scriptedModel } from "../../../tests/support/mock-model.js";
import { formatProbes, probeModels } from "./probe.js";

describe("doctor --models (REQ-LLM-03/AC2)", () => {
  it("REQ-LLM-03/AC2: probes every role's model and reports capability mismatches", async () => {
    const good = scriptedModel([{ tools: [{ name: "ping", input: { value: "ok" } }] }, { text: "done" }]);
    const noTools = scriptedModel([{ text: "done" }], { contextWindow: 200_000 });
    const small = scriptedModel([{ tools: [{ name: "ping", input: { value: "ok" } }] }, { text: "done" }], {
      contextWindow: 8_000,
    });
    const byRole: Record<string, ReturnType<typeof scriptedModel>> = {
      analyst: good,
      planner: noTools,
      author: small,
    };
    const probes = await probeModels(
      {
        forRole: (role) =>
          byRole[role] ? Promise.resolve(byRole[role]) : Promise.reject(new Error("connection refused")),
        resolve: () => Promise.reject(new Error("unused")),
      },
      ["analyst", "planner", "author", "auditor"],
    );
    expect(probes.map((p) => [p.role, p.reachable, p.missing])).toEqual([
      ["analyst", true, []],
      ["planner", true, ["tools (did not call the probe tool)"]],
      ["author", true, ["contextWindow>=128000"]],
      ["auditor", false, []],
    ]);
    const text = formatProbes(probes);
    expect(text).toContain("✔ analyst: mock/scripted ok, tool calls work");
    expect(text).toContain("✘ planner");
    expect(text).toContain("✘ auditor: ? unreachable: connection refused");
  });

  it("expands default to every role", async () => {
    const good = scriptedModel([{ text: "done" }]);
    const probes = await probeModels(
      { forRole: () => Promise.resolve(good), resolve: () => Promise.resolve(good) },
      ["default"],
    );
    expect(probes.map((p) => p.role)).toEqual([
      "analyst",
      "planner",
      "author",
      "healer",
      "auditor",
      "explorer",
      "summary",
      "triage",
    ]);
  });

  it("REQ-GEN-08/AC2: the approval flow's model is probed too, and must be another model than the planner", async () => {
    const answer = (id: string) => ({
      ...scriptedModel([{ tools: [{ name: "ping", input: { value: "ok" } }] }, { text: "done" }]),
      id,
    });
    const planner = answer("local/gemma4:e2b");
    const registry = (approver: ReturnType<typeof answer>) => ({
      forRole: () => Promise.resolve(planner),
      resolve: () => Promise.resolve(approver),
    });
    const other = await probeModels(
      registry(answer("local/qwen3:14b")),
      ["planner"],
      undefined,
      "local/qwen3:14b",
    );
    expect(other.map((p) => [p.role, p.model, p.missing])).toEqual([
      ["planner", "local/gemma4:e2b", []],
      ["approver", "local/qwen3:14b", []],
    ]);
    const same = await probeModels(
      registry(answer("local/gemma4:e2b")),
      ["planner"],
      undefined,
      "local/gemma4:e2b",
    );
    expect(same[1]?.missing).toEqual(["another model than the planner (both are local/gemma4:e2b)"]);
    expect(formatProbes(same)).toContain(
      "✘ approver: local/gemma4:e2b missing another model than the planner",
    );
  });
});
