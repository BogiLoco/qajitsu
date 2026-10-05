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
    ]);
  });
});
