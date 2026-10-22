// Adversarial suite: someone with write access to a run folder tries to get a valid certificate for better results,
// or to make a certified folder say more than was certified. Found in the second review of the certificate flow.
// Scenario catalogue: .claude/skills/adversarial-test/scenarios.md
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { unzip, zip } from "@qajitsu/report";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const SIGNING = "certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }";

/** A demo project whose run ends with TC-01 FAILED (seeded bug); the key exists before or after the run. */
const project = async (keyBeforeRun = true) => {
  const env: Record<string, string> = {};
  const p = await createDemoPipeline({ flag: "BUG_CART_TOTAL_ROUNDING", config: [SIGNING], env });
  cleanups.push(p.cleanup);
  const setKey = async () => {
    const keygen = await p.run(["audit", "keygen"]);
    const privatePath = /Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? "";
    env["QAJITSU_SIGNING_KEY"] = Buffer.from(await readFile(privatePath)).toString("base64");
  };
  if (keyBeforeRun) await setKey();
  const ran = await p.executed();
  return { p, ran, setKey };
};
const passResult = async (runDir: string) => {
  const file = join(runDir, "results", "TC-01.json");
  await writeFile(file, (await readFile(file, "utf8")).replaceAll('"failed"', '"passed"'));
};

describe("no window to certify better results than the run's (REQ-VER-15, REQ-VER-16)", () => {
  it("REQ-VER-15/AC8: a run with a signing key is certified when it ends, so a result edited before publishing is caught", async () => {
    const { p, ran } = await project();
    expect(ran.out).toMatch(/Certificate qjc-[0-9a-f]{20}/);
    await passResult(p.runDir);
    const certify = await p.run(["audit", "certify", "DEMO-1"]);
    expect(certify.exitCode).toBe(1);
    // Caught twice over: the seal of the run's end and the certificate issued then both no longer match.
    expect(certify.out).toMatch(/results\/TC-01\.json changed after (the run|certificate)/);
  }, 180_000);

  it("REQ-VER-16/AC4: without a key at run time, the run seals its results and specs; an edit before certifying is a gap", async () => {
    const { p, setKey } = await project(false);
    await passResult(p.runDir);
    const spec = join(p.runDir, "specs", "TC-02.spec.ts");
    await writeFile(spec, `${await readFile(spec, "utf8")}// edited\n`);
    await setKey();
    const certify = await p.run(["audit", "certify", "DEMO-1"]);
    expect(certify.exitCode).toBe(1);
    expect(certify.out).toContain("results/TC-01.json changed after the run");
    expect(certify.out).toContain("specs/TC-02.spec.ts changed after the run");
  }, 180_000);

  it("REQ-VER-15/AC8: without a key, evidence replaced together with its manifest is still caught by the seal", async () => {
    const { p, setKey } = await project(false);
    const manifestFile = join(p.runDir, "evidence", "manifest.json");
    const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as { path: string; sha256: string }[];
    const first = manifest[0];
    expect(first).toBeDefined();
    const fake = '{"status":200,"body":{"total":1.01}}';
    await writeFile(join(p.runDir, "evidence", first?.path ?? ""), fake);
    const { createHash } = await import("node:crypto");
    if (first) first.sha256 = createHash("sha256").update(fake).digest("hex");
    await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
    await setKey();
    const certify = await p.run(["audit", "certify", "DEMO-1"]);
    expect(certify.exitCode).toBe(1);
    expect(certify.out).toContain("evidence/manifest.json changed after the run");
  }, 180_000);

  it("REQ-VER-07 + REQ-VER-15/AC8: a result rewritten to PASSED after the run is never published, with or without a key", async () => {
    const { p } = await project(false);
    const file = join(p.runDir, "results", "TC-01.json");
    const result = JSON.parse(await readFile(file, "utf8")) as {
      attempts: { outcome: string; assertions: { pass: boolean; actual: unknown; expected: unknown }[] }[];
    };
    for (const a of result.attempts) {
      a.outcome = "passed";
      for (const x of a.assertions) {
        x.pass = true;
        x.actual = x.expected;
      }
    }
    await writeFile(file, JSON.stringify(result, null, 2));
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.exitCode).not.toBe(0);
    expect(published.err).toContain("run-sealed");
    expect(published.err).toContain("results/TC-01.json changed after the run");
  }, 180_000);

  it("REQ-VER-15/AC1: the statuses in the certificate are computed from the files, never taken from run.json", async () => {
    const { p, setKey } = await project(false);
    const record = join(p.runDir, "run.json");
    await writeFile(
      record,
      (await readFile(record, "utf8")).replace('"TC-01": "FAILED"', '"TC-01": "PASSED"'),
    );
    await setKey();
    expect((await p.run(["audit", "certify", "DEMO-1"])).exitCode).toBe(0);
    const envelope = JSON.parse(
      await readFile(join(p.runDir, "certificate", "certificate.dsse.json"), "utf8"),
    ) as {
      payload: string;
    };
    const predicate = (
      JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
        predicate: { statuses: Record<string, string> };
      }
    ).predicate;
    expect(predicate.statuses["TC-01"]).toBe("FAILED");
  }, 180_000);

  it("REQ-VER-15/AC9: a file added after the certificate, or a certificate shown with another run's folder, fails the check", async () => {
    const { p } = await project();
    const planted = join(p.runDir, "evidence", "TC-01", "attempt-1", "S1-99.json");
    await writeFile(planted, '{"status":200,"total":1.01}');
    const added = await p.run(["verify-report", p.runDir]);
    expect(added.exitCode).toBe(1);
    expect(added.out).toContain("added after the certificate: evidence/TC-01/attempt-1/S1-99.json");

    // The same folder presented as another run: run.json names another run id.
    const other = join(p.home, "copy");
    await mkdir(other);
    await cp(p.runDir, other, { recursive: true });
    await writeFile(join(other, "evidence", "TC-01", "attempt-1", "S1-99.json"), "");
    const record = join(other, "run.json");
    await writeFile(
      record,
      (await readFile(record, "utf8")).replaceAll("20261003-1046-aaaa", "20261003-1046-bbbb"),
    );
    const moved = await p.run(["verify-report", other]);
    expect(moved.out).toContain(
      "the certificate is for DEMO-1 run 20261003-1046-aaaa, the folder is DEMO-1 run 20261003-1046-bbbb",
    );
    expect(moved.exitCode).toBe(1);
  }, 180_000);

  it("REQ-VER-15/AC9: an export with two entries of the same name is refused; lines added to a journal are reported", async () => {
    const { p } = await project();
    expect((await p.run(["audit", "export", "DEMO-1", "--out", "a.zip"])).exitCode).toBe(0);
    const entries = unzip(new Uint8Array(await readFile(join(p.project, "a.zip"))));
    const result = entries.find((e) => e.name === "results/TC-01.json");
    const forged = zip([...entries, { name: "results/TC-01.json", data: new TextEncoder().encode("{}") }]);
    await writeFile(join(p.project, "b.zip"), forged);
    expect(result).toBeDefined();
    const duplicated = await p.run(["verify-report", "b.zip"]);
    expect(duplicated.exitCode).toBe(1);
    expect(duplicated.out).toContain("the archive has two entries named results/TC-01.json");

    await writeFile(join(p.runDir, "journal", "events.jsonl"), '{"event":"later"}\n', { flag: "a" });
    const grown = await p.run(["verify-report", p.runDir]);
    expect(grown.out).toContain("is valid");
    expect(grown.exitCode).toBe(0);
    expect(grown.out).toMatch(
      /journal\/events\.jsonl: \d+ byte\(s\) written after the certificate \(not covered\)/,
    );
    expect(grown.out).toMatch(/trusted key [0-9a-f]{16} \(from \.qa\/keys\/[0-9a-f]{16}\.pub\)/);
  }, 180_000);
});
