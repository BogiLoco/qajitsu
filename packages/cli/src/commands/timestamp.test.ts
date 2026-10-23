import { createHash, randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { createFakeTsa, startFakeTsaServer } from "../../../../tests/support/fake-tsa.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const startTsa = async () => {
  const tsa = await startFakeTsaServer();
  cleanups.push(tsa.close);
  return tsa;
};

const certified = async (tsaUrl: string, caPem?: string) => {
  const env: Record<string, string> = {};
  const p = await createDemoPipeline({
    flag: "BUG_CART_TOTAL_ROUNDING",
    config: [
      `certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY, timestamp: { url: "${tsaUrl}", timeout_s: 5 } }`,
    ],
    env,
  });
  cleanups.push(p.cleanup);
  const keygen = await p.run(["audit", "keygen"]);
  const privatePath = /Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? "";
  env["QAJITSU_SIGNING_KEY"] = Buffer.from(await readFile(privatePath)).toString("base64");
  if (caPem !== undefined) {
    await mkdir(join(p.project, ".qa", "keys", "tsa"), { recursive: true });
    await writeFile(join(p.project, ".qa", "keys", "tsa", "fake-tsa.pem"), caPem);
  }
  const payloadDigest = async () => {
    const envelope = JSON.parse(
      await readFile(join(p.runDir, "certificate", "certificate.dsse.json"), "utf8"),
    ) as {
      payload: string;
    };
    return createHash("sha256").update(Buffer.from(envelope.payload, "base64")).digest();
  };
  return { ...p, payloadDigest };
};

describe("trusted timestamps (REQ-VER-17)", () => {
  it("REQ-VER-17/AC1+AC3+AC4: the certificate is timestamped when the run ends; only its hash is sent; verify-report checks the token", async () => {
    const tsa = await startTsa();
    const p = await certified(tsa.url, tsa.caPem);
    const run = await p.executed();
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("Timestamped 2026-10-03T10:46:00.000Z by CN=Fake TSA.");
    // AC4: one small request carrying the SHA-256 of the signed statement, nothing else of the run.
    expect(tsa.requests).toHaveLength(1);
    const request = tsa.requests[0] ?? Buffer.alloc(0);
    expect(request.length).toBeLessThan(80);
    expect(request.includes(await p.payloadDigest())).toBe(true);
    const record = JSON.parse(
      await readFile(join(p.runDir, "certificate", "timestamp.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(record).toMatchObject({
      status: "timestamped",
      trusted: true,
      qualified: false,
      genTime: "2026-10-03T10:46:00.000Z",
    });
    const verified = await p.run(["verify-report", p.runDir]);
    expect(verified.exitCode).toBe(0);
    expect(verified.out).toContain("timestamped 2026-10-03T10:46:00.000Z by CN=Fake TSA (trusted TSA)");
    // Publishing reuses the certificate and its timestamp: no second request.
    const published = await p.run(["publish", "DEMO-1", "--auto-publish"]);
    expect(published.out).toContain("Timestamped 2026-10-03T10:46:00.000Z");
    expect(tsa.requests).toHaveLength(1);
  });

  it("REQ-VER-17/AC5: an unreachable TSA does not block the run; the certificate is stamped later with qj audit timestamp", async () => {
    const tsa = await startTsa();
    const p = await certified("http://127.0.0.1:9/tsr", tsa.caPem);
    const run = await p.executed();
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("Not timestamped (the TSA could not be reached");
    expect(JSON.parse(await readFile(join(p.runDir, "certificate", "timestamp.json"), "utf8"))).toMatchObject(
      {
        status: "not_timestamped",
      },
    );
    expect((await p.run(["verify-report", p.runDir])).out).toContain("not timestamped");
    // The TSA is back (configured anew).
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace("http://127.0.0.1:9/tsr", tsa.url));
    const stamped = await p.run(["audit", "timestamp", "DEMO-1"]);
    expect(stamped.exitCode).toBe(0);
    expect(stamped.out).toContain("Timestamped 2026-10-03T10:46:00.000Z by CN=Fake TSA.");
    expect((await p.run(["verify-report", p.runDir])).exitCode).toBe(0);
  });

  it("REQ-VER-17/AC3: a refused, broken or foreign token is never kept; a token replaced afterwards fails verify-report", async () => {
    const tsa = await startTsa();
    const p = await certified(tsa.url, tsa.caPem);
    tsa.set({ status: 2 });
    expect((await p.executed()).out).toContain(
      "Not timestamped (the TSA refused (status 2: request rejected))",
    );
    tsa.set({ digest: randomBytes(32) });
    const foreign = await p.run(["audit", "timestamp", "DEMO-1"]);
    expect(foreign.exitCode).toBe(1);
    expect(foreign.out).toContain("the token stamps another hash than this certificate's");
    tsa.set({ nonce: Buffer.from("ff", "hex") });
    expect((await p.run(["audit", "timestamp", "DEMO-1"])).out).toContain("does not answer this request");
    tsa.set({}, 500);
    expect((await p.run(["audit", "timestamp", "DEMO-1"])).out).toContain("the TSA answered HTTP 500");
    tsa.set({});
    expect((await p.run(["audit", "timestamp", "DEMO-1"])).exitCode).toBe(0);
    // Someone swaps the token for one of another statement: the check names it.
    const other = createFakeTsa();
    const { timestampRequest, parseTimestampResponse } = await import("@qajitsu/verifier");
    const swapped = parseTimestampResponse(
      other.stamp(timestampRequest(randomBytes(32), randomBytes(8))),
    ).token;
    await writeFile(join(p.runDir, "certificate", "timestamp.tsr"), swapped ?? Buffer.alloc(0));
    const verified = await p.run(["verify-report", p.runDir]);
    expect(verified.exitCode).toBe(1);
    expect(verified.out).toContain("timestamp: the token stamps another hash than this certificate's");
  });

  it("REQ-VER-17/AC2+AC3: a TSA the project does not trust is shown as such; --tsa-ca or a qualified provider's CA makes it trusted", async () => {
    const tsa = await startTsa();
    const p = await certified(tsa.url);
    expect((await p.executed()).out).toContain("the TSA's certificate is not in .qa/keys/tsa/");
    expect((await p.run(["verify-report", p.runDir])).out).toContain(
      "the TSA is not trusted here (pass its CA with --tsa-ca)",
    );
    const ca = join(p.home, "tsa-ca.pem");
    await writeFile(ca, tsa.caPem);
    const verified = await p.run(["verify-report", p.runDir, "--tsa-ca", ca]);
    expect(verified.exitCode).toBe(0);
    expect(verified.out).toContain("(trusted TSA)");
    await rm(join(p.runDir, "certificate", "timestamp.json"));
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      (await readFile(yaml, "utf8")).replace("timeout_s: 5", "timeout_s: 5, qualified: true"),
    );
    expect((await p.run(["audit", "timestamp", "DEMO-1"])).out).toContain("(qualified, eIDAS)");
  });

  it("REQ-VER-17/AC3: a timestamp before the certificate's issue time is refused; a late one says what it proves", async () => {
    const tsa = await startTsa();
    const p = await certified(tsa.url, tsa.caPem);
    tsa.set({ genTime: new Date("2026-10-02T12:00:00Z") });
    expect((await p.executed()).out).toContain(
      "the TSA's time 2026-10-02T12:00:00.000Z is before the certificate's issue time 2026-10-03T10:46:00.000Z; check this machine's clock",
    );
    tsa.set({ genTime: new Date("2026-10-05T10:46:00Z") });
    expect((await p.run(["audit", "timestamp", "DEMO-1"])).exitCode).toBe(0);
    expect((await p.run(["verify-report", p.runDir])).out).toContain(
      "stamped 48 h after the certificate was issued: it proves the certificate existed by then, not earlier",
    );
    // A token planted with an earlier time than the certificate claims: the certificate is dated falsely.
    const { timestampRequest, parseTimestampResponse } = await import("@qajitsu/verifier");
    const early = createFakeTsa();
    const token = parseTimestampResponse(
      early.stamp(timestampRequest(await p.payloadDigest(), randomBytes(8)), {
        genTime: new Date("2026-10-02T12:00:00Z"),
      }),
    ).token;
    await writeFile(join(p.runDir, "certificate", "timestamp.tsr"), token ?? Buffer.alloc(0));
    const verified = await p.run(["verify-report", p.runDir]);
    expect(verified.exitCode).toBe(1);
    expect(verified.out).toContain(
      "timestamp: the certificate claims to be issued 2026-10-03T10:46:00.000Z, after its timestamp",
    );
  });
});
