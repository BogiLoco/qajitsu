// REQ-VER-21: the certificate format is documented well enough that a verifier without QAJitsu checks it: the
// reference verifier in tools/ uses Node.js built-ins only, and `qj verify-report` needs no project, account or server.
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { generateKeyPairSync } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { certificateStatement, certificateSubject, keySigner, signStatement } from "@qajitsu/verifier";
import { createProgram } from "../../packages/cli/src/program.js";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../support/cli-pipeline.js";
import { startFakeTsaServer } from "../support/fake-tsa.js";

const run = promisify(execFile);
const tool = new URL("../../tools/verify-certificate.mjs", import.meta.url).pathname;
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const certifiedRun = async () => {
  const env: Record<string, string> = {};
  const p = await createDemoPipeline({
    config: ["certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }"],
    env,
  });
  cleanups.push(p.cleanup);
  const keygen = await p.run(["audit", "keygen"]);
  env["QAJITSU_SIGNING_KEY"] = Buffer.from(
    await readFile(/Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? ""),
  ).toString("base64");
  await p.executed();
  expect((await p.run(["publish", "DEMO-1", "--auto-publish"])).out).toContain("Certificate qjc-");
  const keys = join(p.project, ".qa", "keys");
  return { p, publicKey: join(keys, (await readdir(keys))[0] ?? "") };
};

const reference = (folder: string, key: string) =>
  run(process.execPath, [tool, folder, key]).then(
    (r) => ({ code: 0, out: r.stdout }),
    (e: unknown) => {
      const failed = e as { code: number; stdout: string };
      return { code: failed.code, out: failed.stdout };
    },
  );

describe("open verifier (REQ-VER-21)", () => {
  it("REQ-VER-21/AC1+AC2: a verifier written from the format description alone, with Node.js built-ins, checks a real certificate and names a changed file", async () => {
    const { p, publicKey } = await certifiedRun();
    const ok = await reference(p.runDir, publicKey);
    expect(ok.out).toMatch(
      /^VALID qjc-[0-9a-f]{20}: DEMO-1 run 20261003-1046-aaaa, \d+ files, root [0-9a-f]{64}\n$/,
    );
    expect(ok.code).toBe(0);
    const matrix = join(p.runDir, "report", "matrix.md");
    await writeFile(matrix, `${await readFile(matrix, "utf8")} `);
    const bad = await reference(p.runDir, publicKey);
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("  - changed: report/matrix.md");
    await writeFile(join(p.runDir, "evidence", "planted.json"), "{}");
    expect((await reference(p.runDir, publicKey)).out).toContain(
      "  - added after the certificate: evidence/planted.json",
    );
  }, 180_000);

  it("REQ-VER-21/AC1: qj verify-report works outside any project, offline, with only the public key", async () => {
    const { p, publicKey } = await certifiedRun();
    const nowhere = await mkdtemp(join(tmpdir(), "qj-auditor-"));
    cleanups.push(() => rm(nowhere, { recursive: true, force: true }));
    let out = "";
    let exitCode = -1;
    await createProgram("1.0.0", {
      write: (t) => (out += t),
      writeError: (t) => (out += t),
      cwd: nowhere,
      nodeVersion: "v22.22.0",
      setExitCode: (c) => (exitCode = c),
      user: "auditor",
      ports: {
        env: {},
        home: nowhere,
        now: () => new Date(0),
        random: () => 0,
        gitExec: () => Promise.reject(new Error("git used")),
        // Offline: any network call fails the test.
        fetch: () => Promise.reject(new Error("network used")),
      },
    })
      .exitOverride()
      .parseAsync(["node", "qj", "verify-report", p.runDir, "--key", publicKey]);
    expect(out).toContain("is valid");
    expect(exitCode).toBe(0);
  }, 180_000);

  it("REQ-VER-21/AC1: a forged certificate cannot make the reference verifier read outside the folder", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-forged-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const run = join(dir, "run");
    await mkdir(join(run, "certificate"), { recursive: true });
    await writeFile(join(dir, "outside.txt"), "x");
    const key = generateKeyPairSync("ed25519");
    const subject = {
      ...certificateSubject("outside.txt", new TextEncoder().encode("x")),
      name: "../outside.txt",
    };
    const envelope = signStatement(
      certificateStatement([subject], { ticket: "DEMO-1", runId: "r", issuedAt: "t" }),
      keySigner(key.privateKey),
    );
    await writeFile(join(run, "certificate", "certificate.dsse.json"), JSON.stringify(envelope));
    await writeFile(join(dir, "key.pem"), key.publicKey.export({ type: "spki", format: "pem" }).toString());
    const r = await reference(run, join(dir, "key.pem"));
    expect(r.code).toBe(1);
    expect(r.out).toContain('unsafe file name: "../outside.txt"');
  });

  it("REQ-VER-21/AC1 + REQ-VER-17/AC3: the reference verifier checks the timestamp token and its TSA", async () => {
    const tsa = await startFakeTsaServer();
    cleanups.push(tsa.close);
    const env: Record<string, string> = {};
    const p = await createDemoPipeline({
      config: [
        `certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY, timestamp: { url: "${tsa.url}" } }`,
      ],
      env,
    });
    cleanups.push(p.cleanup);
    const keygen = await p.run(["audit", "keygen"]);
    env["QAJITSU_SIGNING_KEY"] = Buffer.from(
      await readFile(/Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? ""),
    ).toString("base64");
    expect((await p.executed()).out).toContain("Timestamped");
    const keys = join(p.project, ".qa", "keys");
    const publicKey = join(keys, (await readdir(keys)).find((f) => f.endsWith(".pub")) ?? "");
    const ca = join(p.home, "tsa-ca.pem");
    await writeFile(ca, tsa.caPem);
    const withCa = await run(process.execPath, [tool, p.runDir, publicKey, "--tsa-ca", ca]);
    expect(withCa.stdout).toContain("  timestamped 20261003104600Z by CN=Fake TSA (trusted TSA)");
    const without = await run(process.execPath, [tool, p.runDir, publicKey]);
    expect(without.stdout).toContain("(TSA not trusted: pass --tsa-ca)");
    // A token of another statement is named.
    const token = join(p.runDir, "certificate", "timestamp.tsr");
    const bytes = await readFile(token);
    const digestAt = bytes.indexOf(Buffer.from([0x04, 0x20]), 40);
    bytes[digestAt + 2] = (bytes[digestAt + 2] ?? 0) ^ 0xff;
    await writeFile(token, bytes);
    const bad = await reference(p.runDir, publicKey);
    expect(bad.code).toBe(1);
    expect(bad.out).toMatch(/timestamp: (stamps another hash|message digest does not match)/);
  });
});
