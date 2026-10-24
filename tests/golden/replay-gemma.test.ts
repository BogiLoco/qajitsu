// REQ-LLM-14/AC5: answers a real local model (gemma4:e2b through Ollama) gave in the exploratory lab, replayed
// through today's analyst and planner code: a change to the parsers, the conversions or the plan checks shows here
// against real model output, without calling a model.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";
import { recordedAnswers } from "../support/replay.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("replay of recorded model answers (REQ-LLM-14/AC5)", () => {
  it("REQ-LLM-14/AC5: gemma4:e2b's analysis and plan for DEMO-1, invalid answers and repairs included, go through the current checks", async () => {
    const turns = recordedAnswers(
      new URL("../../fixtures/transcripts/demo-1-gemma4-e2b.jsonl", import.meta.url),
      ["analyst", "planner"],
    );
    expect(turns).toHaveLength(4);
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-1"]);
    const planned = await p.run(["plan", "DEMO-1"], { script: turns });
    expect(planned.err).toBe("");
    expect(planned.out.replaceAll(p.runDir, "<run>")).toMatchSnapshot();
    // The plan code made from the model's answer: conversions and checks of today change it only on purpose.
    expect(await readFile(join(p.runDir, "plan", "plan.v1.yaml"), "utf8")).toMatchSnapshot();
  }, 120_000);
});
