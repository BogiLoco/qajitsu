import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline, flowScript } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

describe("model inputs rebuilt from their snapshots (REQ-CTX-17/AC4)", () => {
  it("REQ-CTX-17/AC4: qj audit verify rebuilds every model input of a run and names a changed or missing fragment", async () => {
    const p = await createDemoPipeline({});
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-1"]);
    const [analysis, draft] = flowScript("DEMO-1");
    expect((await p.run(["plan", "DEMO-1"], { script: [analysis as never, draft as never] })).exitCode).toBe(
      0,
    );
    const ok = await p.run(["audit", "verify", "DEMO-1"]);
    expect(ok.exitCode).toBe(0);
    expect(ok.out).toMatch(/✔ DEMO-1\/.+: \d+ model input\(s\) rebuilt from their snapshots/);
    // A kept fragment that changes after the run, and one that disappears, are named by kind, source and hash.
    const dir = join(p.runDir, "context", "fragments");
    const names = await readdir(dir);
    let changed = "";
    for (const n of names)
      if ((await readFile(join(dir, n), "utf8")).startsWith("Key: DEMO-1")) {
        changed = n;
        await writeFile(join(dir, n), "Key: DEMO-1\nSummary: something else");
      }
    expect(changed).not.toBe("");
    const other = names.find((n) => n !== changed) ?? "";
    await rm(join(dir, other));
    const bad = await p.run(["audit", "verify", "DEMO-1"]);
    expect(bad.exitCode).toBe(1);
    expect(bad.out).toContain("model inputs");
    expect(bad.out).toMatch(
      /call 1 \(analyze\/analyst\): ticket ticket\/DEMO-1 changed \(sha256 [0-9a-f]{12}\)/,
    );
    expect(bad.out).toMatch(/ missing \(sha256 [0-9a-f]{12}\)/);
  }, 120_000);
});
