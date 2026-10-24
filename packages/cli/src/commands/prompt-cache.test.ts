import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("prompt cache duration of a run (REQ-LLM-12/AC2)", () => {
  it("REQ-LLM-12/AC2: auto chooses from the project's model calls and records why; a configured duration is recorded as such", async () => {
    const auto = await createDemoPipeline();
    cleanups.push(auto.cleanup);
    await auto.run(["fetch", "DEMO-1"]);
    await auto.run(["plan", "DEMO-1"], { script: flowScript("DEMO-1") });
    const record = JSON.parse(await readFile(join(auto.runDir, "run.json"), "utf8")) as {
      data: { promptCache: { ttl: string; basis: string } };
    };
    expect(record.data.promptCache).toEqual({ ttl: "5m", basis: "no earlier model calls in this project" });
    expect(await readFile(join(auto.runDir, "journal", "events.jsonl"), "utf8")).toContain(
      '"models.cache_ttl"',
    );

    const fixed = await createDemoPipeline({
      config: ["models: { roles: { default: mock/scripted }, cache_ttl: 1h }"],
    });
    cleanups.push(fixed.cleanup);
    // The harness already writes models; the second key would be invalid, so replace its line instead.
    const yaml = join(fixed.project, ".qa", "qa.project.yaml");
    const text = (await readFile(yaml, "utf8")).split("\n");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      yaml,
      text
        .filter((l, i) => !(l.startsWith("models:") && text.findIndex((x) => x.startsWith("models:")) !== i))
        .map((l) =>
          l.startsWith("models:") ? "models: { roles: { default: mock/scripted }, cache_ttl: 1h }" : l,
        )
        .join("\n"),
    );
    await fixed.run(["fetch", "DEMO-1"]);
    await fixed.run(["plan", "DEMO-1"], { script: flowScript("DEMO-1") });
    const record2 = JSON.parse(await readFile(join(fixed.runDir, "run.json"), "utf8")) as {
      data: { promptCache: { ttl: string; basis: string } };
    };
    expect(record2.data.promptCache).toEqual({ ttl: "1h", basis: "models.cache_ttl" });
  }, 180_000);
});
