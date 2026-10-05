import { createHash } from "node:crypto";
import type { EvidenceStore } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

const bytes = (s: string) => new TextEncoder().encode(s);

/**
 * Shared contract every EvidenceStore passes (REQ-VER-05, invariant 7, REQ-GEN-02/AC3): every stored file is in
 * the manifest with its SHA-256 and size, nothing is overwritten, nothing escapes the evidence folder.
 *
 * @param name - Implementation name for test titles.
 * @param create - Builds an empty store.
 * @param read - Reads a stored file back by its manifest path.
 */
export function evidenceStoreContract(
  name: string,
  create: () => Promise<EvidenceStore>,
  read: (store: EvidenceStore, path: string) => Promise<Uint8Array>,
): void {
  describe(`EvidenceStore contract: ${name}`, () => {
    it("REQ-GEN-02/AC3 + REQ-VER-05/AC1: put returns and lists the entry with SHA-256, size, case and step", async () => {
      const store = await create();
      const content = bytes('{"status":200}');
      const entry = await store.put(
        { path: "TC-01/attempt-1/S1-01.json", caseId: "TC-01", stepId: "S1", kind: "response" },
        content,
      );
      expect(entry).toEqual({
        path: "TC-01/attempt-1/S1-01.json",
        caseId: "TC-01",
        stepId: "S1",
        kind: "response",
        sha256: createHash("sha256").update(content).digest("hex"),
        bytes: content.byteLength,
      });
      expect(await store.manifest()).toEqual([entry]);
      expect(await read(store, entry.path)).toEqual(content);
    });

    it("REQ-GEN-02/AC3 + invariant 7: concurrent puts all end up in the manifest", async () => {
      const store = await create();
      const ids = Array.from({ length: 20 }, (_, i) => `S${String(i)}`);
      await Promise.all(
        ids.map((id) =>
          store.put(
            { path: `TC-01/attempt-1/${id}.png`, caseId: "TC-01", stepId: id, kind: "screenshot" },
            bytes(id),
          ),
        ),
      );
      expect((await store.manifest()).map((e) => e.stepId).sort()).toEqual([...ids].sort());
    });

    it("REQ-GEN-02/AC3: evidence is never overwritten", async () => {
      const store = await create();
      const entry = { path: "TC-01/attempt-1/S1.png", caseId: "TC-01", kind: "screenshot" } as const;
      await store.put(entry, bytes("first"));
      await expect(store.put(entry, bytes("second"))).rejects.toThrow();
      expect(await read(store, entry.path)).toEqual(bytes("first"));
      expect(await store.manifest()).toHaveLength(1);
    });

    it("REQ-GEN-02/AC3: paths outside the evidence folder and the manifest itself are refused", async () => {
      const store = await create();
      for (const path of ["../escape.txt", "/abs/file.txt", "TC-01/../../x.txt", "manifest.json"])
        await expect(store.put({ path, caseId: "TC-01", kind: "other" }, bytes("x")), path).rejects.toThrow();
      expect(await store.manifest()).toEqual([]);
    });
  });
}
