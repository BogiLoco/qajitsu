import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { PNG } from "pngjs";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const KEY = "TC-01/S1-checkout.chromium-desktop";

/** DEMO-4 with a visual expectation on the checkout page (TC-01 S1), against a real Chromium. */
const pipeline = async (baseline?: Uint8Array) => {
  const p = await createDemoPipeline({
    ticket: "DEMO-4",
    transformPlan: (draft) => {
      const plan = JSON.parse(draft) as { cases: { steps: { expect: Record<string, unknown> }[] }[] };
      const s1 = plan.cases[0]?.steps[0];
      if (s1) s1.expect = { ...s1.expect, visual: { name: "checkout" } };
      return JSON.stringify(plan);
    },
    transformSpec: (id, code) =>
      id === "TC-01"
        ? code.replace(
            'await ui.goto("/app/checkout");',
            'await ui.goto("/app/checkout");\n    verify("S1", "visual", undefined, plan.expect("TC-01.S1.visual"));',
          )
        : code,
  });
  cleanups.push(p.cleanup);
  if (baseline) {
    const file = join(p.project, ".qa", "baselines", `${KEY}.png`);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, baseline);
  }
  const results = async () =>
    (
      JSON.parse(await readFile(join(p.runDir, "run.json"), "utf8")) as {
        data: { results: Record<string, string> };
      }
    ).data.results;
  return { ...p, results };
};

describe("visual regression (REQ-EXEC-12)", () => {
  it("REQ-EXEC-12/AC3+AC4: no baseline: NEEDS_REVIEW with the screenshot proposed; a person accepts it into .qa/baselines/", async () => {
    const p = await pipeline();
    await p.executed();
    expect((await p.results())["TC-01"]).toBe("NEEDS_REVIEW");
    expect(await readFile(join(p.runDir, "results", "TC-01.json"), "utf8")).toContain(
      "(no baseline yet: this screenshot is proposed)",
    );
    expect((await p.run(["baseline", "accept", "DEMO-4"])).err).toContain(
      "Not interactive: nothing accepted",
    );
    await expect(readdir(join(p.project, ".qa", "baselines"))).rejects.toThrow();
    const accepted = await p.run(["baseline", "accept", "DEMO-4", "--yes"]);
    expect(accepted.out).toContain(`${KEY}.png  (TC-01, no baseline)`);
    expect(accepted.out).toContain("Accepted 1 baseline(s). Commit .qa/baselines/");
    const png = PNG.sync.read(await readFile(join(p.project, ".qa", "baselines", `${KEY}.png`)));
    expect(png.width).toBe(1280);
  }, 240_000);

  it("REQ-EXEC-12/AC1+AC2: the same page matches its baseline (PASSED); a different baseline fails with baseline, screenshot and diff", async () => {
    const first = await pipeline();
    await first.executed();
    await first.run(["baseline", "accept", "DEMO-4", "--yes"]);
    const approved = await readFile(join(first.project, ".qa", "baselines", `${KEY}.png`));

    const same = await pipeline(approved);
    await same.executed();
    expect((await same.results())["TC-01"]).toBe("PASSED");

    // A changed design: the baseline's top half is painted over.
    const img = PNG.sync.read(approved);
    for (let i = 0; i < img.data.length / 2; i += 4) img.data[i] = 255 - (img.data[i] ?? 0);
    const changed = await pipeline(new Uint8Array(PNG.sync.write(img)));
    const r = await changed.executed();
    expect(r.exitCode).toBe(1);
    expect((await changed.results())["TC-01"]).toBe("FAILED");
    const manifest = await readFile(join(changed.runDir, "evidence", "manifest.json"), "utf8");
    for (const name of ["S1-visual-actual.png", "S1-visual-baseline.png", "S1-visual-diff.png"])
      expect(manifest).toContain(name);
    // Changed screenshots become baselines only on request.
    expect((await changed.run(["baseline", "accept", "DEMO-4", "--yes"])).out).toContain(
      "add --include-failed",
    );
    expect((await changed.run(["baseline", "accept", "DEMO-4", "--yes", "--include-failed"])).out).toContain(
      "(TC-01, differs from the baseline)",
    );
  }, 300_000);

  it("REQ-EXEC-12/AC4: a screenshot changed after the run is never accepted as a baseline", async () => {
    const p = await pipeline();
    await p.executed();
    const manifest = await readFile(join(p.runDir, "evidence", "manifest.json"), "utf8");
    const path = /"path": "(TC-01\/attempt-1\/S1-visual-actual\.png)"/.exec(manifest)?.[1] ?? "";
    await writeFile(join(p.runDir, "evidence", path), "not the screenshot");
    const r = await p.run(["baseline", "accept", "DEMO-4", "--yes"]);
    expect(r.exitCode).toBe(3);
    expect(r.err).toContain("[BASELINE_EVIDENCE_CHANGED]");
    await expect(readdir(join(p.project, ".qa", "baselines"))).rejects.toThrow();
  }, 240_000);
});
