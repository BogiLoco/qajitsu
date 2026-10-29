import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createDemoPipeline, DEMO_PASSWORD } from "../../../../tests/support/cli-pipeline.js";
import { compareReproduction } from "./reproduce.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

/** A certified run of DEMO-1 with the rounding bug on: TC-01 FAILED, TC-02 PASSED. */
const certifiedRun = async () => {
  const env: Record<string, string> = {};
  // Run ids come from the fixed test clock and a random suffix: the reproduction needs a real one.
  let random = (): number => 0;
  const p = await createDemoPipeline({
    flag: "BUG_CART_TOTAL_ROUNDING",
    config: ["certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }"],
    env,
    ports: { random: () => random() },
  });
  cleanups.push(p.cleanup);
  const keygen = await p.run(["audit", "keygen"]);
  env["QAJITSU_SIGNING_KEY"] = Buffer.from(
    await readFile(/Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? ""),
  ).toString("base64");
  expect((await p.executed()).out).toContain("Certificate qjc-");
  random = Math.random;
  return p;
};

describe("reproduce a run from its certificate (REQ-VER-20)", () => {
  it("REQ-VER-20/AC2: same, different and not reproducible per case", () => {
    expect(
      compareReproduction(
        { "TC-01": "FAILED", "TC-02": "PASSED", "TC-03": "PASSED", "TC-04": "PASSED" },
        { "TC-01": "FAILED", "TC-02": "FAILED", "TC-03": "BLOCKED" },
      ).map((c) => [c.caseId, c.result]),
    ).toEqual([
      ["TC-01", "same"],
      ["TC-02", "different"],
      ["TC-03", "not reproducible"],
      ["TC-04", "not reproducible"],
    ]);
  });

  it("REQ-VER-20/AC1+AC2+AC3: the certified plan and tests run again without agents; the same environment gives the same statuses and its own certificate; the original is untouched", async () => {
    const p = await certifiedRun();
    const original = await readFile(join(p.runDir, "run.json"), "utf8");
    const before = JSON.parse(original) as { data: { approval: { sha256: string } } };
    const r = await p.run(["reproduce", p.runDir]);
    expect(r.err).toBe("");
    // REQ-CTX-17/AC4: every model input of the certified run is rebuilt from its snapshot first.
    expect(r.out).toMatch(/Model inputs: \d+ model input\(s\) rebuilt from their snapshots/);
    expect(r.out).toContain("TC-01: FAILED → FAILED  same");
    expect(r.out).toContain("TC-02: PASSED → PASSED  same");
    expect(r.out).toMatch(/Certificate qjc-[0-9a-f]{20}/);
    expect(r.exitCode).toBe(0);
    // No agent was asked anything, and the frozen plan is byte for byte the certified one.
    expect(r.model.mock.doGenerateCalls).toHaveLength(0);
    const runId = /as run (\S+)/.exec(r.out)?.[1] ?? "";
    const again = JSON.parse(await readFile(join(p.home, "runs", "DEMO-1", runId, "run.json"), "utf8")) as {
      data: { approval: { sha256: string }; reproduction: { cases: unknown[] } };
    };
    expect(again.data.approval.sha256).toBe(before.data.approval.sha256);
    expect(again.data.reproduction.cases).toHaveLength(2);
    expect(await readFile(join(p.runDir, "run.json"), "utf8")).toBe(original);
  }, 180_000);

  it("REQ-VER-20/AC2: against a shop without the bug the FAILED case is different; a run that is not certified, or changed, is not reproduced", async () => {
    const p = await certifiedRun();
    const clean = await startShop({ env: { DEMO_USER_PASSWORD: DEMO_PASSWORD } });
    cleanups.push(() => clean.close());
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace("allowlist: ['", `allowlist: ['${clean.url}', '`),
    );
    const r = await p.run(["reproduce", p.runDir, "--env", clean.url]);
    expect(r.out).toContain("TC-01: FAILED → PASSED  different");
    expect(r.exitCode).toBe(1);

    const result = join(p.runDir, "results", "TC-01.json");
    await writeFile(result, (await readFile(result, "utf8")).replace('"failed"', '"passed"'));
    const refused = await p.run(["reproduce", p.runDir]);
    expect(refused.exitCode).toBe(3);
    expect(refused.err).toContain("REPRODUCE_SOURCE_INVALID");
    expect(refused.err).toContain("changed: results/TC-01.json");
  }, 180_000);
});
