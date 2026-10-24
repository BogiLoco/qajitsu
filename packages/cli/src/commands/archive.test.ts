import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createRunWorkspace, type TicketKey } from "@qajitsu/core";
import { unzip } from "@qajitsu/report";
import { afterEach, describe, expect, it } from "vitest";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";
import { startFakeS3 } from "../../../../tests/support/fake-s3.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

type FakeS3 = Awaited<ReturnType<typeof startFakeS3>>;

/** A certified demo run whose project keeps runs in the fake S3 for ten years. */
const archived = async (s3: FakeS3, secret = s3.credentials.secretAccessKey) => {
  const env: Record<string, string> = { QJ_S3_KEY: s3.credentials.accessKeyId, QJ_S3_SECRET: secret };
  const p = await createDemoPipeline({
    flag: "BUG_CART_TOTAL_ROUNDING",
    config: [
      "certificate: { signing_key: secret://env/QAJITSU_SIGNING_KEY }",
      `archive: { type: s3, endpoint: "${s3.endpoint}", bucket: ${s3.bucket}, path_style: true, access_key_id: secret://env/QJ_S3_KEY, secret_access_key: secret://env/QJ_S3_SECRET, retention_days: 3650 }`,
    ],
    env,
  });
  cleanups.push(p.cleanup);
  const keygen = await p.run(["audit", "keygen"]);
  env["QAJITSU_SIGNING_KEY"] = Buffer.from(
    await readFile(/Private key \(mode 0600\): (\S+)/.exec(keygen.out)?.[1] ?? ""),
  ).toString("base64");
  return p;
};
const s3 = async (o: Parameters<typeof startFakeS3>[0] = {}) => {
  const server = await startFakeS3(o);
  cleanups.push(server.close);
  return server;
};
const PREFIX = "qajitsu/DEMO-1/20261003-1046-aaaa/";
const UNTIL = "2036-09-30T10:46:00.000Z";

describe("write-once evidence storage (REQ-VER-19)", () => {
  it("REQ-VER-19/AC1+AC3: a certified run goes to S3 Object Lock with the retention its certificate states", async () => {
    const store = await s3();
    const p = await archived(store);
    const run = await p.executed();
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain(
      `Archived write-once at s3://qa-evidence/${PREFIX} (compliance) until ${UNTIL}.`,
    );
    // AC3: the certificate says where and until when, inside what is signed.
    const envelope = JSON.parse(
      await readFile(join(p.runDir, "certificate", "certificate.dsse.json"), "utf8"),
    ) as {
      payload: string;
    };
    const statement = JSON.parse(Buffer.from(envelope.payload, "base64").toString("utf8")) as {
      predicate: { storage: unknown };
    };
    expect(statement.predicate.storage).toEqual({
      kind: "s3-object-lock",
      location: `s3://qa-evidence/${PREFIX}`,
      mode: "compliance",
      retainUntil: UNTIL,
    });
    // AC1: the audit export (with the certificate) and the certificate, each locked.
    expect([...store.objects.keys()].sort()).toEqual([
      `${PREFIX}audit.zip`,
      `${PREFIX}certificate.dsse.json`,
    ]);
    for (const versions of store.objects.values())
      expect(versions[0]).toMatchObject({ mode: "COMPLIANCE", retainUntil: UNTIL });
    const zip = store.objects.get(`${PREFIX}audit.zip`)?.[0]?.data ?? Buffer.alloc(0);
    const names = unzip(new Uint8Array(zip)).map((e) => e.name);
    expect(names).toContain("certificate/certificate.dsse.json");
    expect(names).toContain("evidence/manifest.json");
    expect(store.requests.every((r) => r.authorized)).toBe(true);
    const record = JSON.parse(await readFile(join(p.runDir, "certificate", "archive.json"), "utf8")) as {
      objects: { key: string; sha256: string }[];
    };
    expect(record.objects.find((o) => o.key.endsWith("audit.zip"))?.sha256).toBe(
      createHash("sha256").update(zip).digest("hex"),
    );
    const verified = await p.run(["verify-report", p.runDir]);
    expect(verified.exitCode).toBe(0);
    expect(verified.out).toContain(
      `kept write-once at s3://qa-evidence/${PREFIX} (compliance) until ${UNTIL}; archived`,
    );
    // Publishing reuses the certificate and its archive: nothing written twice.
    expect((await p.run(["publish", "DEMO-1", "--auto-publish"])).out).toContain("Archived write-once");
    expect(store.requests.filter((r) => r.method === "PUT")).toHaveLength(2);
  });

  it("REQ-VER-19/AC2: a locked run is not deleted locally before its retention ends, nor is its project", async () => {
    const store = await s3();
    const p = await archived(store);
    await p.executed();
    const reset = await p.run(["work", "reset", "DEMO-1", "--delete"]);
    expect(reset.out).toContain(
      `DEMO-1/20261003-1046-aaaa: kept, it is locked in write-once storage until ${UNTIL}`,
    );
    expect(await readFile(join(p.runDir, "run.json"), "utf8")).toContain('"archive"');
    // Runs kept elsewhere (workspace.root) are not touched by removing the project; runs in its home are.
    const home = join(p.home, ".qajitsu", "projects", "demo", "runs");
    const ws = await createRunWorkspace({
      root: home,
      ticket: "DEMO-7" as TicketKey,
      now: () => new Date("2026-10-03T10:46:00Z"),
      random: () => 0.5,
    });
    await ws.update({ data: { ...ws.record.data, archive: { location: "s3://x/", retainUntil: UNTIL } } });
    const removed = await p.run(["projects", "remove", "demo", "--yes"]);
    expect(removed.exitCode).toBe(3);
    expect(removed.err).toContain(
      `keeps runs in write-once storage; it cannot be removed before their retention ends:\n  DEMO-7/${ws.runId} until ${UNTIL}`,
    );
    expect(await readFile(join(ws.dir, "run.json"), "utf8")).toContain(UNTIL);
  });

  it("REQ-VER-19/AC1: storage without Object Lock, a lock not held, or wrong keys never stop the run; the reason is kept and audit archive tries again", async () => {
    const noLock = await s3({ objectLock: false });
    const p = await archived(noLock);
    const run = await p.executed();
    expect(run.exitCode).toBe(1);
    expect(run.out).toContain("Not archived (The archive refused");
    expect(run.out).toContain("HTTP 400 InvalidRequest.); try again with qj audit archive.");
    expect(JSON.parse(await readFile(join(p.runDir, "certificate", "archive.json"), "utf8"))).toMatchObject({
      status: "not_archived",
    });
    expect((await p.run(["verify-report", p.runDir])).out).toContain("not archived: The archive refused");
    // The storage is fixed: try again.
    const fixed = await s3();
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(yaml, (await readFile(yaml, "utf8")).replace(noLock.endpoint, fixed.endpoint));
    const again = await p.run(["audit", "archive", "DEMO-1"]);
    expect(again.exitCode).toBe(0);
    expect(again.out).toContain("Archived write-once");
  });

  it("REQ-VER-19/AC1: a store that answers 200 but holds no lock is not trusted; wrong keys are named without the secret", async () => {
    const ignoring = await s3({ ignoreLock: true });
    const p = await archived(ignoring);
    expect((await p.executed()).out).toContain(
      "is stored without a compliance lock (is Object Lock enabled?)",
    );
    const store = await s3();
    const q = await archived(store, "not-the-secret");
    const run = await q.executed();
    expect(run.out).toContain("HTTP 403 SignatureDoesNotMatch");
    expect(run.out + run.err).not.toContain("not-the-secret");
    const record = await readFile(join(q.runDir, "certificate", "archive.json"), "utf8");
    expect(record).not.toContain("not-the-secret");
  });
});
