import type { AgentTool } from "@qajitsu/agents";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { oneAtATime } from "./one-at-a-time.js";

const tool = (name: string, log: string[], ms: number, fail = false): AgentTool => ({
  name,
  description: name,
  inputSchema: z.object({}),
  async execute() {
    log.push(`${name} start`);
    await new Promise((r) => setTimeout(r, ms));
    log.push(`${name} end`);
    if (fail) throw new Error(`${name} failed`);
    return name;
  },
});

describe("explorer tools one at a time (REQ-EXEC-15/AC9)", () => {
  it("REQ-EXEC-15/AC9: calls made at once run in the order asked, and a failing one does not block the rest", async () => {
    const log: string[] = [];
    const [slow, failing, fast] = oneAtATime([
      tool("slow", log, 30),
      tool("failing", log, 1, true),
      tool("fast", log, 1),
    ]);
    const results = await Promise.allSettled([slow?.execute({}), failing?.execute({}), fast?.execute({})]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    expect(log).toEqual(["slow start", "slow end", "failing start", "failing end", "fast start", "fast end"]);
  });

  it("REQ-EXEC-15/AC5+AC9: once the session is aborted, queued calls do not start", async () => {
    const log: string[] = [];
    const stop = new AbortController();
    const [first, second] = oneAtATime([tool("first", log, 20), tool("second", log, 1)]);
    const a = first?.execute({}, stop.signal);
    const b = second?.execute({}, stop.signal);
    // The time box ends while the first call runs.
    await new Promise((r) => setTimeout(r, 5));
    stop.abort();
    expect(await a).toBe("first");
    expect(await b).toMatch(/^ABORTED/);
    expect(log).toEqual(["first start", "first end"]);
  });
});
