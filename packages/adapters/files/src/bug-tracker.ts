import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError, type BugMatch, type BugTracker } from "@qajitsu/core";
import { z } from "zod";

const KEY = /^[A-Z][A-Z0-9_]+-\d+$/;

const FileIssue = z.object({
  key: z.string(),
  type: z.string().default("Story"),
  status: z.string().default("Unknown"),
  summary: z.string(),
  components: z.array(z.string()).default([]),
});

/**
 * Bug tracker for `jira.type: file` (demo, offline, tests): searches the ticket files for open bugs and writes new
 * bugs and links as JSON files into `outDir` instead of sending them.
 *
 * @param ticketsDir - Directory of `<KEY>.json` tickets.
 * @param outDir - Where created bugs and links are written.
 */
export function createFileBugTracker(ticketsDir: string, outDir: string): BugTracker {
  return {
    async findSimilar(search) {
      const words = search.words.map((w) => w.toLowerCase());
      const out: BugMatch[] = [];
      for (const name of (await readdir(ticketsDir).catch(() => [] as string[]))
        .filter((n) => n.endsWith(".json"))
        .sort()) {
        const parsed = FileIssue.safeParse(JSON.parse(await readFile(join(ticketsDir, name), "utf8")));
        if (!parsed.success) continue;
        const t = parsed.data;
        if (t.type.toLowerCase() !== "bug" || /^(done|closed|resolved)$/i.test(t.status)) continue;
        if (!t.key.startsWith(`${search.project}-`)) continue;
        if (!words.some((w) => t.summary.toLowerCase().includes(w))) continue;
        out.push({ key: t.key, summary: t.summary, status: t.status });
      }
      return out;
    },
    async createBug(draft) {
      await mkdir(outDir, { recursive: true });
      const existing = (await readdir(outDir)).filter((n) => /^[A-Z].*-\d+\.json$/.test(n)).length;
      const key = `${draft.project}-${String(9001 + existing)}`;
      await writeFile(join(outDir, `${key}.json`), `${JSON.stringify({ key, ...draft }, null, 2)}\n`);
      return { key, url: `file://${join(outDir, `${key}.json`)}` };
    },
    async link(from, to) {
      if (!KEY.test(from) || !KEY.test(to))
        throw new AdapterError("JIRA_KEY_INVALID", "Invalid issue key.", {});
      await mkdir(outDir, { recursive: true });
      await writeFile(
        join(outDir, `link-${from}-${to}.json`),
        `${JSON.stringify({ type: "Relates", from, to })}\n`,
      );
    },
  };
}
