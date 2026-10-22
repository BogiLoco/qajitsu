import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const SIGNING = "certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }";

/** A demo project with a signing key created by `qj audit keygen` and stored like a CI secret. */
const certifiedProject = async (config: string[] = [SIGNING]) => {
  const env: Record<string, string> = {};
  const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING", config, env });
  cleanups.push(p.cleanup);
  const keygen = await p.run(["audit", "keygen"]);
  expect(keygen.exitCode).toBe(0);
  const privatePath = /Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? "";
  // REQ-VER-15/AC6: the private key is never printed and is readable by the owner only.
  expect(keygen.out).not.toContain("PRIVATE KEY");
  expect((await stat(privatePath)).mode & 0o777).toBe(0o600);
  const publicKeys = await readdir(join(p.project, ".qa", "keys"));
  expect(publicKeys).toHaveLength(1);
  env["QAJITSU_SIGNING_KEY"] = Buffer.from(await readFile(privatePath)).toString("base64");
  return { p, env, publicKey: join(p.project, ".qa", "keys", publicKeys[0] ?? "") };
};

describe("signed test certificate (REQ-VER-15)", () => {
  it("REQ-VER-15/AC1+AC2+AC3+AC7: publishing issues a signed certificate shown in the comment and report; verify-report checks it, also after the reports are rendered again", async () => {
    const { p } = await certifiedProject();
    await p.executed();
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.err).toBe("");
    const id = /Certificate (qjc-[0-9a-f]{20}), Merkle root ([0-9a-f]{64})/.exec(published.out);
    // Shown once, in the comment's preview.
    expect(published.out.split("Merkle root").length - 1).toBe(1);
    expect(id).not.toBeNull();
    const [, certId = "", root = ""] = id ?? [];
    expect(await readFile(join(p.runDir, "report", "report.html"), "utf8")).toContain(certId);
    expect(await readFile(join(p.runDir, "report", "published", "jira-comment.adf.json"), "utf8")).toContain(
      `Certificate ${certId}, Merkle root ${root}`,
    );
    const envelope = JSON.parse(
      await readFile(join(p.runDir, "certificate", "certificate.dsse.json"), "utf8"),
    ) as { payload: string };
    const predicate = (
      JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
        predicate: Record<string, unknown>;
      }
    ).predicate;
    expect(predicate).toMatchObject({
      ticket: "DEMO-1",
      merkleRoot: root,
      planSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      manifestSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      matrixSha256: expect.stringMatching(/^[0-9a-f]{64}$/) as unknown,
      decision: "Decision: NO-GO (policy v1): TC-01 FAILED (high)",
      issuedAt: "2026-10-03T10:46:00.000Z",
    });
    expect(predicate["versions"]).toBeDefined();
    expect(predicate["environment"]).toBeDefined();

    const verified = await p.run(["verify-report", p.runDir]);
    expect(verified.out).toContain(`✔ Certificate ${certId} is valid`);
    expect(verified.exitCode).toBe(0);
    // Rendering the reports again and publishing again keep the same certificate.
    expect((await p.run(["export", "DEMO-1", "--out", "x"])).exitCode).toBe(1);
    const again = await p.run(["verify-report", p.runDir]);
    expect(again.out).toContain("is valid");
    expect(again.exitCode).toBe(0);
    expect((await p.run(["publish", "DEMO-1", "--auto-publish"])).out).toContain(`Certificate ${certId}`);
  }, 180_000);

  it("REQ-VER-15/AC3+AC6: the audit export verifies offline with the public key; a changed result is named; the run is not certified again over it", async () => {
    const { p, publicKey } = await certifiedProject();
    await p.executed();
    const certified = await p.run(["audit", "certify", "DEMO-1"]);
    expect(certified.exitCode).toBe(0);
    expect((await p.run(["audit", "export", "DEMO-1", "--out", "audit.zip"])).exitCode).toBe(0);
    // An auditor outside the project, with only the zip and the public key.
    const outside = await p.run(["verify-report", join(p.project, "audit.zip"), "--key", publicKey]);
    expect(outside.out).toContain("is valid");

    const result = join(p.runDir, "results", "TC-01.json");
    await writeFile(result, (await readFile(result, "utf8")).replace('"failed"', '"passed"'));
    const tampered = await p.run(["verify-report", p.runDir]);
    expect(tampered.exitCode).toBe(1);
    expect(tampered.out).toContain("does NOT verify");
    expect(tampered.out).toContain("changed: results/TC-01.json");
    const again = await p.run(["audit", "certify", "DEMO-1"]);
    expect(again.exitCode).toBe(1);
    // Since REQ-VER-15/AC8 the seal of the run's end catches it before the certificate is even looked at.
    expect(again.out).toMatch(
      /results\/TC-01.json changed after (the run|certificate qjc-[0-9a-f]{20} was issued)/,
    );
  }, 180_000);

  it("REQ-VER-15/AC4 + REQ-VER-16/AC4: an incomplete trail gets no certificate; with certificate.required the run is not published", async () => {
    const { p } = await certifiedProject([`${SIGNING.slice(0, -2)}, required: true }`]);
    await p.executed();
    await writeFile(join(p.runDir, "journal", "agents.jsonl"), "");
    const certify = await p.run(["audit", "certify", "DEMO-1"]);
    expect(certify.exitCode).toBe(1);
    expect(certify.out).toContain("✘ No certificate: the audit trail has");
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.exitCode).not.toBe(0);
    expect(published.err).toContain("No certificate: the audit trail has");
    // The reasons are named, not only counted.
    expect(published.err).toMatch(/- journal\/agents\.jsonl is missing|model exchange/);
    expect(await readdir(join(p.runDir, "report", "published")).catch(() => [])).not.toContain(
      "jira-comment.wiki.txt",
    );
    // The run was certified when it ended (REQ-VER-15/AC8): the emptied transcript shows as a change.
    expect((await p.run(["verify-report", p.runDir])).out).toContain("changed: journal/agents.jsonl");
  }, 180_000);
});
