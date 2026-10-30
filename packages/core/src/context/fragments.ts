import { createHash } from "node:crypto";
import { z } from "zod";

/** Kinds of model input (REQ-CTX-11/AC1). */
export const CONTEXT_KINDS = [
  "role-instructions",
  "project-rules",
  "skill",
  "repository",
  "ticket",
  "plan",
  "analysis",
  "diff",
  "file",
  "knowledge",
  "result",
  "evidence",
  "log",
  "tool-result",
  "lesson",
  "question",
  "spec",
  "ui",
  "imported",
  "exploration",
  "map",
  "catalogue",
] as const;

/** One kind of {@link CONTEXT_KINDS}. */
export type ContextKind = (typeof CONTEXT_KINDS)[number];

/**
 * One piece of model input with its origin, trust and size (REQ-CTX-11/AC1). `trusted` is QAJitsu's own text and the
 * approved plan; everything from tickets, code, pages, logs and tool output is `untrusted`. Pinned fragments (plan,
 * expectations, rubric) are never dropped, trimmed, summarised or compacted (AC2). `stable` fragments come first so
 * provider caching applies (REQ-CTX-12/AC2).
 */
export const ContextFragmentSchema = z.strictObject({
  kind: z.enum(CONTEXT_KINDS),
  /** File path, ticket key, tool call id or URL, e.g. `TC-01/results.json`. */
  source: z.string().min(1).max(500),
  trust: z.enum(["trusted", "untrusted"]),
  section: z.enum(["stable", "varying"]),
  /** Higher comes first within a section and is kept longer. */
  priority: z.number().int().min(0).max(100),
  pinned: z.boolean(),
  /**
   * Material a role may need but does not always need (whole documents, test indexes, older results): offered as a
   * handle in the catalogue, read with `read_context` when needed (REQ-CTX-12/AC5).
   */
  onDemand: z.boolean().optional(),
  text: z.string(),
  /** Estimated tokens of the text. */
  tokens: z.number().int().min(0),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** A fragment of model input. */
export type ContextFragment = z.infer<typeof ContextFragmentSchema>;

/** A fragment as recorded in a snapshot: everything but its text. */
export const SnapshotFragmentSchema = ContextFragmentSchema.omit({ text: true });

/**
 * What one model call was given (REQ-CTX-17/AC3): the ordered fragments without their texts, the reductions, the
 * run's block marker, the renderer and the model; `sha256` is the hash over all of it and goes into the journal.
 */
export const ContextSnapshotSchema = z.strictObject({
  schema: z.literal(1),
  stage: z.string().min(1),
  role: z.string().min(1),
  model: z.string().min(1),
  renderer: z.string().min(1),
  marker: z.string().regex(/^[a-z0-9]{8,32}$/),
  fragments: z.array(SnapshotFragmentSchema),
  reductions: z.array(
    z.strictObject({
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      action: z.enum(["dropped", "deduplicated", "trimmed", "handle", "summarised", "compacted"]),
      reason: z.string().min(1).max(500),
      tokensSaved: z.number().int().min(0),
    }),
  ),
  /** Input tokens by fragment kind (REQ-CTX-18/AC1). */
  tokensByKind: z.record(z.string(), z.number().int().min(0)),
  /** The call's budget and how it was counted (REQ-CTX-14/AC1+AC4, REQ-LLM-15/AC2); absent without a model profile. */
  budget: z
    .strictObject({
      tokens: z.number().int().min(0),
      used: z.number().int().min(0),
      margin: z.number().positive(),
      counting: z.enum(["estimate", "provider"]),
      style: z.enum(["full", "compact"]),
      profile: z.string(),
      /** Shares of the budget per fragment kind that applied (REQ-CTX-14/AC1). */
      shares: z.record(z.string(), z.number().min(0).max(1)).optional(),
    })
    .optional(),
  /** Fragments behind handles, readable with `read_context` (REQ-CTX-12/AC4+AC5). */
  catalogue: z
    .array(
      z.strictObject({
        handle: z.string().regex(/^h-[0-9a-f]{8}$/),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        kind: z.string(),
        source: z.string(),
        tokens: z.number().int().min(0),
      }),
    )
    .default([]),
  /** The embedding model whose similarities were a second signal, and its version (REQ-CTX-20/AC6); absent without one. */
  embedding: z.strictObject({ model: z.string().min(1), version: z.string().optional() }).optional(),
  /** Relevance of the fragments that compete for the budget, with the terms that matched (REQ-CTX-12/AC6). */
  ranking: z
    .array(
      z.strictObject({
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        score: z.number().min(0),
        terms: z.array(z.string()).max(8),
        semantic: z.number().min(-1).max(1).optional(),
      }),
    )
    .default([]),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
});

/** A snapshot of one call's context. */
export type ContextSnapshot = z.infer<typeof ContextSnapshotSchema>;

/** Tokens of a text, estimated the way `@qajitsu/models` counts input (about four characters per token). */
const estimate = (text: string): number => Math.ceil(text.length / 4);

/**
 * Builds a fragment with its hash and token estimate (REQ-CTX-11/AC1).
 *
 * @param input - Kind, source, trust, layout section, priority, pinned flag and text.
 * @example
 * const ticket = fragment({ kind: "ticket", source: "DEMO-1", trust: "untrusted", section: "varying", priority: 80, pinned: false, text });
 */
export function fragment(input: Omit<ContextFragment, "tokens" | "sha256">): ContextFragment {
  return {
    ...input,
    tokens: estimate(input.text),
    sha256: createHash("sha256").update(input.text).digest("hex"),
  };
}

/** Canonical JSON (sorted keys) for hashing snapshots. */
const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/**
 * The hash of a snapshot over everything but its own hash (REQ-CTX-17/AC3): the same fragments, reductions, marker,
 * renderer and model give the same hash.
 *
 * @param snapshot - The snapshot without `sha256`.
 */
export function snapshotHash(snapshot: Omit<z.input<typeof ContextSnapshotSchema>, "sha256">): string {
  return createHash("sha256").update(canonical(snapshot)).digest("hex");
}
