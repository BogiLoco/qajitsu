import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { z } from "zod";
import { isNeverIndexed } from "../knowledge/extract.js";
import { KnowledgeSourceSchema } from "../knowledge/sources.js";
import { ProjectSlugSchema } from "./registry.js";

/** A path inside `.qa/`: relative, `/`-separated, without `..` or empty segments. */
const QaRelativePath = z
  .string()
  .min(1)
  .max(300)
  .refine(
    (p) =>
      !p.startsWith("/") &&
      !/^[a-zA-Z]:/.test(p) &&
      p.split("/").every((s) => s !== "" && s !== ".." && s !== "."),
    "Expected a relative path inside .qa/",
  );

/**
 * A portable project profile (REQ-PRJ-09/AC1): identity, the text files of `.qa/` and the knowledge sources, never the
 * knowledge index, runs or secret values.
 */
export const ProjectProfileSchema = z.strictObject({
  schema: z.literal(1),
  kind: z.literal("qajitsu-project-profile"),
  exported_at: z.string(),
  slug: ProjectSlugSchema,
  jira_prefixes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/)).default([]),
  /** Where `.qa/` was on the exporting machine; informational. */
  qa_dir: z.string(),
  qa_files: z.array(z.strictObject({ path: QaRelativePath, text: z.string() })).default([]),
  knowledge_sources: z.array(KnowledgeSourceSchema.omit({ synced_at: true })).default([]),
});

/** A portable project profile. */
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>;

/** Largest `.qa/` file a profile carries. */
export const PROFILE_FILE_MAX_BYTES = 512 * 1024;

/**
 * The text files of a `.qa/` folder for a profile (REQ-PRJ-09/AC1). Environment files, keys, certificates and
 * credential stores are never included; binary and oversized files are listed as skipped.
 *
 * @param qaDir - The `.qa/` folder.
 */
export async function collectQaFiles(
  qaDir: string,
): Promise<{ files: { path: string; text: string }[]; skipped: { path: string; reason: string }[] }> {
  const files: { path: string; text: string }[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const abs = join(dir, entry.name);
      const rel = relative(qaDir, abs).split(sep).join("/");
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules" && entry.name !== ".git") await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isNeverIndexed(rel)) {
        skipped.push({ path: rel, reason: "environment, key or credential file" });
        continue;
      }
      if ((await stat(abs)).size > PROFILE_FILE_MAX_BYTES) {
        skipped.push({ path: rel, reason: "larger than 512 KB" });
        continue;
      }
      const bytes = await readFile(abs);
      if (bytes.includes(0)) {
        skipped.push({ path: rel, reason: "binary file" });
        continue;
      }
      files.push({ path: rel, text: bytes.toString("utf8") });
    }
  };
  await walk(qaDir);
  return { files, skipped };
}
