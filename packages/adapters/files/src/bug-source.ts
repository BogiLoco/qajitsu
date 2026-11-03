import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { AdapterError, bugMarkdown, componentTag, type DocumentSource } from "@qajitsu/core";
import { z } from "zod";

const FileBugSchema = z.object({
  key: z.string(),
  type: z.string().default("Story"),
  status: z.string().default("Unknown"),
  summary: z.string(),
  description: z.string().default(""),
  components: z.array(z.string()).default([]),
  updated: z.string().optional(),
  resolution: z.string().optional(),
  comments: z.array(z.object({ author: z.string(), body: z.string() })).default([]),
});

const DONE = /^(done|closed|resolved|fixed)$/i;

/**
 * Resolved bugs from ticket files (`jira.type: file`): the same source for offline demos and tests
 * (REQ-KNOW-12/AC2).
 *
 * @param dir - Directory of `<KEY>.json` tickets.
 */
export function createFileBugSource(
  dir: string,
  options: { readonly component?: string | undefined } = {},
): DocumentSource {
  const read = async (): Promise<z.infer<typeof FileBugSchema>[]> => {
    const out: z.infer<typeof FileBugSchema>[] = [];
    for (const name of (await readdir(dir)).filter((n) => n.endsWith(".json")).sort()) {
      const parsed = FileBugSchema.safeParse(JSON.parse(await readFile(join(dir, name), "utf8")));
      if (!parsed.success) continue;
      const t = parsed.data;
      if (t.type.toLowerCase() !== "bug" || !DONE.test(t.status)) continue;
      if (options.component !== undefined && !t.components.includes(options.component)) continue;
      out.push(t);
    }
    return out;
  };
  return {
    async list() {
      return (await read()).map((t) => ({
        id: t.key,
        title: t.summary,
        version: t.updated ?? `${t.status}:${String(t.description.length)}`,
        modifiedAt: t.updated ?? new Date(0).toISOString(),
        tags: t.components.map(componentTag),
      }));
    },
    async load(document) {
      const t = (await read()).find((x) => x.key === document.id);
      if (!t) throw new AdapterError("JIRA_ISSUE_NOT_FOUND", `${document.id} is not a resolved bug.`, {});
      return {
        format: "markdown",
        text: bugMarkdown(t.key, t.summary, {
          components: t.components,
          resolution: t.resolution ?? t.status,
          fixVersions: [],
          description: t.description,
          comments: t.comments.slice(-5).map((c) => `${c.author}: ${c.body}`),
        }),
      };
    },
  };
}
