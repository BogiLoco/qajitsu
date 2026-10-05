import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evidenceStoreContract } from "../../../../tests/contract/evidence-store.contract.js";
import { createLocalEvidenceStore, readManifest } from "./local-store.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const bytes = (s: string) => new TextEncoder().encode(s);

const storeDirs = new WeakMap<object, string>();
evidenceStoreContract(
  "local",
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-ev-contract-"));
    dirs.push(dir);
    const store = createLocalEvidenceStore(dir);
    storeDirs.set(store, dir);
    return store;
  },
  async (store, path) => new Uint8Array(await readFile(join(storeDirs.get(store) ?? "", path))),
);

describe("local evidence store (REQ-VER-05/AC1, invariant 7)", () => {
  it("REQ-VER-05/AC1: writes files and a manifest with SHA-256, size, case and step", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-ev-"));
    dirs.push(dir);
    const store = createLocalEvidenceStore(dir);
    const [a, b] = await Promise.all([
      store.put(
        { path: "TC-01/attempt-1/S1-01.json", caseId: "TC-01", stepId: "S1", kind: "response" },
        bytes("{}"),
      ),
      store.put(
        { path: "TC-02/attempt-1/S1-01.json", caseId: "TC-02", stepId: "S1", kind: "response" },
        bytes("[1]"),
      ),
    ]);
    expect(a.sha256).toBe(createHash("sha256").update("{}").digest("hex"));
    expect(b.bytes).toBe(3);
    expect(await readManifest(dir)).toEqual([a, b]);
    expect(await readFile(join(dir, "TC-01/attempt-1/S1-01.json"), "utf8")).toBe("{}");
    expect(await store.manifest()).toHaveLength(2);
  });

  it("never overwrites evidence and stays inside evidence/", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-ev-"));
    dirs.push(dir);
    const store = createLocalEvidenceStore(dir);
    await store.put({ path: "x.json", caseId: "TC-01", kind: "log" }, bytes("1"));
    await expect(
      store.put({ path: "x.json", caseId: "TC-01", kind: "log" }, bytes("2")),
    ).rejects.toMatchObject({ code: "EVIDENCE_EXISTS" });
    for (const path of ["../results/TC-01.json", "/etc/x", "manifest.json"]) {
      await expect(store.put({ path, caseId: "TC-01", kind: "log" }, bytes("1"))).rejects.toMatchObject({
        code: "EVIDENCE_PATH_INVALID",
      });
    }
  });

  it("reports an invalid manifest and returns an empty one when missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "qj-ev-"));
    dirs.push(dir);
    expect(await readManifest(dir)).toEqual([]);
    await writeFile(join(dir, "manifest.json"), "{bad");
    await expect(readManifest(dir)).rejects.toMatchObject({ code: "EVIDENCE_MANIFEST_INVALID" });
  });
});
