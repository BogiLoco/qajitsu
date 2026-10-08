import { copyFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEventLines } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import { createAnthropicApi } from "../../../../tests/support/anthropic-api.js";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const KEY = "sk-ant-api03-flow-test-key-111111";
const fixture = (path: string) => fileURLToPath(new URL(`../../../../fixtures/${path}`, import.meta.url));

describe("the whole flow through a cloud provider (REQ-LLM-01/AC6)", () => {
  it("REQ-LLM-01/AC6: fetch, plan with analyst and planner on the Anthropic API, approve and run on the demo shop", async () => {
    const p = await createDemoPipeline();
    cleanups.push(p.cleanup);
    // The project uses Claude through the Anthropic provider; the key comes from .env.local like in real use.
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace(
        "models: { roles: { default: mock/scripted } }",
        "models: { providers: { anthropic: { type: anthropic, api_key: secret://env/ANTHROPIC_API_KEY } }, roles: { default: anthropic/claude-sonnet-5-5 } }",
      ),
    );
    await writeFile(join(p.project, ".env.local"), `ANTHROPIC_API_KEY=${KEY}\n`);
    const analysis = JSON.stringify({
      summary: "Cart API.",
      change_type: ["api"],
      endpoints: [{ method: "GET", path: "/cart", source: [{ kind: "ac", id: "AC1" }] }],
      confidence: "high",
    });
    const api = createAnthropicApi(
      [{ text: analysis }, { text: await readFile(fixture("plans/demo-1-draft.json"), "utf8") }],
      { apiKey: KEY },
    );
    // Only api.anthropic.com is answered by the stand-in; the demo shop on localhost is real.
    const fetch: typeof globalThis.fetch = (input, init) =>
      String(input instanceof Request ? input.url : input).startsWith("https://api.anthropic.com/")
        ? api.fetch(input, init)
        : globalThis.fetch(input, init);

    expect((await p.run(["fetch", "DEMO-1"], { fetch })).exitCode).toBe(0);
    const planned = await p.run(["plan", "DEMO-1"], { fetch });
    expect(planned.err).toBe("");
    expect(planned.exitCode).toBe(0);
    expect((await p.run(["approve", "DEMO-1"], { fetch })).exitCode).toBe(0);
    for (const id of ["TC-01", "TC-02"])
      await copyFile(fixture(`specs/demo-1/${id}.spec.ts`), join(p.runDir, "specs", `${id}.spec.ts`));
    const ran = await p.run(["run", "DEMO-1"], { fetch });
    expect(ran.exitCode).toBe(0);
    expect(ran.out).toContain("2 cases: 2 PASSED");

    expect(api.violations).toEqual([]);
    expect(api.requests).toHaveLength(2);
    const { events } = parseEventLines(await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8"));
    expect(
      events.filter((e) => e.event === "model.usage").map((e) => (e.details as { model: string }).model),
    ).toEqual(["anthropic/claude-sonnet-5-5", "anthropic/claude-sonnet-5-5"]);
    // The key never reaches the journal, logs or the run record.
    for (const file of ["journal/events.jsonl", "logs/qajitsu.log", "run.json"])
      expect(await readFile(join(p.runDir, file), "utf8").catch(() => "")).not.toContain(KEY);
    const record = JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
      data: { versions: Record<string, string> };
    };
    expect(record.data.versions["model default"]).toBe("anthropic/claude-sonnet-5-5");
  }, 240_000);
});
