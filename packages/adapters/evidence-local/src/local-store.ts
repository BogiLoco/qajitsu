import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { AdapterError, type EvidenceEntry, type EvidenceStore } from "@qajitsu/core";
import { z } from "zod";

/** Manifest file name inside `evidence/`. */
export const MANIFEST_FILE = "manifest.json";

/** Manifest paths stay inside `evidence/`: relative, no `..` segments, no backslashes. */
const SafePath = z
  .string()
  .min(1)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !p.includes("\\") &&
      !p.split("/").some((s) => s === ".." || s === "." || s === "") &&
      p !== MANIFEST_FILE,
    "path must stay inside evidence/",
  );

const EntrySchema = z.strictObject({
  path: SafePath,
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  caseId: z.string(),
  stepId: z.string().optional(),
  kind: z.enum(["request", "response", "screenshot", "video", "trace", "log", "har", "dom", "other"]),
  bytes: z.number().int().nonnegative(),
});

/**
 * Reads `evidence/manifest.json`; an empty list when it does not exist.
 *
 * @param evidenceDir - The run's `evidence/` folder.
 */
export async function readManifest(evidenceDir: string): Promise<EvidenceEntry[]> {
  try {
    return z
      .array(EntrySchema)
      .parse(JSON.parse(await readFile(join(evidenceDir, MANIFEST_FILE), "utf8"))) as EvidenceEntry[];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw new AdapterError(
      "EVIDENCE_MANIFEST_INVALID",
      "evidence/manifest.json is unreadable or invalid.",
      {},
    );
  }
}

/**
 * Creates the local evidence store of one run. Writes are serialised so the manifest never loses entries.
 *
 * @param evidenceDir - The run's `evidence/` folder.
 * @example
 * const store = createLocalEvidenceStore(ws.path("evidence"));
 * await store.put({ path: "TC-01/attempt-1/S1-01.json", caseId: "TC-01", stepId: "S1", kind: "response" }, bytes);
 */
export function createLocalEvidenceStore(evidenceDir: string): EvidenceStore {
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = queue.then(fn, fn);
    queue = next.catch(() => undefined);
    return next;
  };
  return {
    put(entry, content) {
      return serial(async () => {
        const rel = normalize(entry.path);
        if (isAbsolute(rel) || rel.startsWith("..") || rel === MANIFEST_FILE) {
          throw new AdapterError("EVIDENCE_PATH_INVALID", "Evidence path must stay inside evidence/.", {
            path: entry.path,
          });
        }
        const manifest = await readManifest(evidenceDir);
        if (manifest.some((m) => m.path === rel)) {
          throw new AdapterError("EVIDENCE_EXISTS", "Evidence files are never overwritten.", { path: rel });
        }
        const file = join(evidenceDir, rel);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, content, { flag: "wx" });
        const stored: EvidenceEntry = {
          ...entry,
          path: rel.split("\\").join("/"),
          sha256: createHash("sha256").update(content).digest("hex"),
          bytes: content.byteLength,
        };
        const tmp = join(evidenceDir, `${MANIFEST_FILE}.tmp`);
        await writeFile(tmp, `${JSON.stringify([...manifest, stored], null, 2)}\n`);
        await rename(tmp, join(evidenceDir, MANIFEST_FILE));
        return stored;
      });
    },
    manifest: () => readManifest(evidenceDir),
  };
}
