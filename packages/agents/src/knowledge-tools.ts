import { isOutdated, type EventLog, type KnowledgeChunk, type KnowledgeHit } from "@qajitsu/core";
import { z } from "zod";
import { untrusted } from "./context.js";
import type { AgentTool } from "./loop.js";

/** Results of one `search_docs` call at most. */
export const SEARCH_DOCS_LIMIT = 8;

/**
 * Read access to the run's project knowledge base (REQ-KNOW-06/AC1, REQ-PRJ-04/AC2). Built by the CLI from the
 * resolved project only; agents never get a path or a store handle.
 */
export interface KnowledgeAccess {
  /** `full`: all documentation fits the prompt; `hybrid`: only search (REQ-KNOW-07). */
  readonly mode: "full" | "hybrid";
  search(query: string, tags: readonly string[], limit: number): Promise<readonly KnowledgeHit[]>;
  /** Every chunk; used in full mode only. */
  all(): Promise<readonly KnowledgeChunk[]>;
  /** `knowledge.max_age_days` (REQ-KNOW-10/AC1). */
  readonly maxAgeDays?: number | undefined;
}

/** Renders a chunk for a prompt: id, path, section, date and a freshness warning, then the text as untrusted data. */
export function renderChunk(chunk: KnowledgeChunk, maxAgeDays: number | undefined, now: Date): string {
  const outdated = isOutdated(chunk, maxAgeDays, now) ? ", possibly outdated" : "";
  return [
    `[chunk ${chunk.id}] ${chunk.path}${chunk.section ? ` › ${chunk.section}` : ""} (modified ${chunk.modifiedAt.slice(0, 10)}${outdated})`,
    untrusted(`knowledge:${chunk.path}`, chunk.text),
  ].join("\n");
}

/**
 * The `search_docs(query, tags?)` tool of the analyst and planner (REQ-KNOW-06/AC1+AC2+AC4+AC5): the same tool in
 * both retrieval modes (REQ-KNOW-07/AC3). Results carry chunk id, path, section and date; text is wrapped as
 * untrusted data. Every call is journaled with the returned chunk ids, and the chunks are remembered for the
 * verbatim quote check.
 */
export function createKnowledgeTools(options: {
  readonly access: KnowledgeAccess;
  readonly stage: string;
  readonly role: string;
  readonly events: EventLog;
  readonly now: () => Date;
  readonly remember: (chunks: readonly KnowledgeChunk[]) => Promise<void>;
}): AgentTool[] {
  const { access } = options;
  return [
    {
      name: "search_docs",
      description:
        'Search the project\'s documentation (specifications, API docs, rules). Returns ranked excerpts with chunk id, file, section and date. Cite one as {"kind":"doc","chunk":"<chunk id>","quote":"<exact words from it>"}.',
      inputSchema: z.object({
        query: z.string().min(2).max(500),
        tags: z.array(z.string().max(40)).max(10).optional(),
      }),
      async execute(input) {
        const query = String(input["query"]);
        const tags = Array.isArray(input["tags"]) ? input["tags"].map(String) : [];
        const hits = await access.search(query, tags, SEARCH_DOCS_LIMIT);
        const chunks = hits.map((h) => h.chunk);
        await options.remember(chunks);
        options.events.emit(options.stage, { kind: "agent", name: options.role }, "knowledge.search", {
          query,
          tags,
          chunks: chunks.map((c) => c.id),
        });
        if (chunks.length === 0) return "No matching documentation.";
        const now = options.now();
        return chunks.map((c) => renderChunk(c, access.maxAgeDays, now)).join("\n\n");
      },
    },
  ];
}

/**
 * The prompt section about the project's documentation: in full mode every chunk (REQ-KNOW-07/AC1), in hybrid mode
 * a pointer to `search_docs`. Chunks given in full are remembered for the quote check.
 */
export async function documentationSection(
  access: KnowledgeAccess,
  remember: (chunks: readonly KnowledgeChunk[]) => Promise<void>,
  now: Date,
): Promise<string> {
  if (access.mode === "hybrid")
    return "## Project documentation\nThe project has a documentation knowledge base. Use the search_docs tool to look up rules and specifications that concern this change.";
  const chunks = await access.all();
  if (chunks.length === 0) return "";
  await remember(chunks);
  return [
    "## Project documentation (all of it; search_docs searches the same chunks)",
    ...chunks.map((c) => renderChunk(c, access.maxAgeDays, now)),
  ].join("\n\n");
}

/**
 * Fills `path`, `section`, `modified` and `outdated` of every documentation source from the stored chunk, so plans
 * show where a quote comes from and whether it may be outdated (REQ-KNOW-06/AC2, REQ-KNOW-10/AC1). Values from the
 * model are replaced, never trusted.
 */
export function annotateDocSources<T>(
  value: T,
  docs: ReadonlyMap<string, KnowledgeChunk>,
  maxAgeDays: number | undefined,
  now: Date,
): T {
  const visit = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(visit);
    if (node === null || typeof node !== "object") return node;
    const record = node as Record<string, unknown>;
    if (record["kind"] === "doc" && typeof record["chunk"] === "string") {
      const chunk = docs.get(record["chunk"]);
      if (!chunk) return record;
      return {
        kind: "doc",
        chunk: chunk.id,
        quote: record["quote"],
        path: chunk.path,
        ...(chunk.section ? { section: chunk.section } : {}),
        modified: chunk.modifiedAt,
        ...(isOutdated(chunk, maxAgeDays, now) ? { outdated: true } : {}),
      };
    }
    return Object.fromEntries(Object.entries(record).map(([k, v]) => [k, visit(v)]));
  };
  return visit(value) as T;
}
