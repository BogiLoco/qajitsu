import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBuildProject } from "../../../../tests/support/cli-build.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("tool versions of a run (REQ-OBS-10/AC2)", () => {
  it("REQ-OBS-10/AC2: report.html, qj runs, qj evidence and the ticket comment show what the run used", async () => {
    const p = await createBuildProject();
    cleanups.push(p.cleanup);
    const dir = await p.prepare();
    await p.run(["run", "DEMO-1", "--build"]);
    const runId = dir.split("/").at(-1) ?? "";
    const tools = /qajitsu \d+\.\d+\.\d+[^ ]* · os .+ · node v[\d.]+ · git [\d.]+/;
    expect(await readFile(join(dir, "report", "report.html"), "utf8")).toMatch(
      new RegExp(`Tools: ${tools.source}`),
    );
    const runs = await p.run(["runs", "DEMO-1"]);
    expect(runs.out).toMatch(
      new RegExp(`Tools:\\n  ${runId}: ${tools.source}.* · model default mock/scripted`),
    );
    const evidence = await p.run(["evidence", "DEMO-1", "--no-open"]);
    expect(evidence.out).toMatch(new RegExp(`^Tools: ${tools.source}`, "m"));
    const published = await p.run(["publish", "DEMO-1"], undefined, { ask: ["y"] });
    expect(published.out).toMatch(new RegExp(`Tools: ${tools.source}`));
    const wiki = await readFile(join(dir, "report", "published", "jira-comment.wiki.txt"), "utf8");
    expect(wiki).toMatch(/Tools: qajitsu/);
  }, 240_000);
});
