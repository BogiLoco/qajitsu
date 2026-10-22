// Adversarial suite: someone tries to obtain or fake a certificate for results that are better than the run's.
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { generateKeyPairSync } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { certificateStatement, certificateSubject, keySigner, signStatement } from "@qajitsu/verifier";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const certifiedRun = async () => {
  const env: Record<string, string> = {};
  const p = await createDemoPipeline({
    flag: "BUG_CART_TOTAL_ROUNDING",
    config: ["certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }"],
    env,
  });
  cleanups.push(p.cleanup);
  const keygen = await p.run(["audit", "keygen"]);
  const privatePath = /Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? "";
  env["QAJITSU_SIGNING_KEY"] = Buffer.from(await readFile(privatePath)).toString("base64");
  await p.executed();
  return p;
};

describe("a certificate cannot vouch for better results than the run's (REQ-VER-15)", () => {
  it("REQ-VER-15/AC3: a report edited to say PASSED before certifying is rendered again by code; the certificate covers the computed report", async () => {
    const p = await certifiedRun();
    const report = join(p.runDir, "report", "report.html");
    await writeFile(report, (await readFile(report, "utf8")).replaceAll("FAILED", "PASSED"));
    expect((await p.run(["audit", "certify", "DEMO-1"])).exitCode).toBe(0);
    expect(await readFile(report, "utf8")).toContain("FAILED");
    expect((await p.run(["verify-report", p.runDir])).exitCode).toBe(0);
  }, 180_000);

  it("REQ-VER-15/AC2+AC3: a certificate signed with another key is not trusted; one copied onto other files does not verify", async () => {
    const p = await certifiedRun();
    expect((await p.run(["audit", "certify", "DEMO-1"])).exitCode).toBe(0);
    const certFile = join(p.runDir, "certificate", "certificate.dsse.json");
    const genuine = await readFile(certFile, "utf8");

    // The attacker edits a result and signs a fresh certificate over the edited files with their own key.
    const result = join(p.runDir, "results", "TC-01.json");
    await writeFile(result, (await readFile(result, "utf8")).replace('"failed"', '"passed"'));
    const own = generateKeyPairSync("ed25519");
    const files = ["results/TC-01.json", "report/matrix.md"];
    const subjects = await Promise.all(
      files.map(async (f) => certificateSubject(f, new Uint8Array(await readFile(join(p.runDir, f))))),
    );
    const forged = signStatement(
      certificateStatement(subjects, {
        ticket: "DEMO-1",
        runId: "20261003-1046-aaaa",
        issuedAt: "2026-10-03T10:46:00.000Z",
      }),
      keySigner(own.privateKey),
    );
    await writeFile(certFile, JSON.stringify(forged));
    const untrusted = await p.run(["verify-report", p.runDir]);
    expect(untrusted.exitCode).toBe(1);
    expect(untrusted.out).toContain("which is not a trusted key");

    // The genuine certificate put back over the edited result names the edit.
    await writeFile(certFile, genuine);
    const copied = await p.run(["verify-report", p.runDir]);
    expect(copied.exitCode).toBe(1);
    expect(copied.out).toContain("changed: results/TC-01.json");
    expect(await readdir(join(p.project, ".qa", "keys"))).toHaveLength(1);
  }, 180_000);
});
