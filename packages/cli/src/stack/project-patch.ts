import { ConfigError } from "@qajitsu/core";
import { parseDocument, type Document } from "yaml";
import { STACK_OLLAMA_URL } from "./compose.js";
import { withTag } from "./images.js";

/** The provider alias the stack's Ollama gets in `models.providers`. */
export const STACK_PROVIDER = "stack";
/** The secret:// reference QAJitsu reads the stack's Chroma URL from; the stack sets the variable. */
export const STACK_CHROMA_REF = "secret://env/QAJITSU_CHROMA_URL";

const DEFAULT_EMBEDDING = "ollama/nomic-embed-text";

/** The parts of `qa.project.yaml` the stack reads, as plain values. */
interface StackView {
  readonly models?: {
    readonly providers?: Record<string, { readonly type?: unknown } | undefined>;
    readonly roles?: Record<string, unknown>;
  };
  readonly knowledge?: { readonly embedding?: unknown };
}
const view = (doc: Document): StackView => (doc.toJS() ?? {}) as StackView;

/**
 * `qa.project.yaml` with its models served by the stack (REQ-GEN-10/AC3): a `stack` Ollama provider, the given roles
 * on it, the knowledge base's embedding model on it when that is an Ollama model, and the stack's Chroma when it runs
 * one. Comments, order and every other key stay as they were.
 *
 * @param source - The file's text.
 * @param input - `role` (or `default`) to Ollama model, and whether the stack runs Chroma.
 * @throws {ConfigError} `STACK_PROVIDER_TAKEN` when `models.providers.stack` is something else already.
 */
export function patchProjectForStack(
  source: string,
  input: {
    readonly roles: Readonly<Record<string, string>>;
    readonly chroma: boolean;
    /** What each stack model can do, declared for QAJitsu's capability check (REQ-LLM-03), which has no profile of it. */
    readonly capabilities?: Readonly<
      Record<string, { readonly tools: boolean; readonly vision: boolean; readonly context_window: number }>
    >;
  },
): string {
  const doc = parseDocument(source);
  const before = view(doc);
  const existing = before.models?.providers?.[STACK_PROVIDER];
  const provider = { type: "ollama", base_url: STACK_OLLAMA_URL };
  if (existing !== undefined) {
    // The declared capabilities under it are the stack's own; only type and address must match.
    const { type, base_url } = existing as { type?: unknown; base_url?: unknown };
    if (JSON.stringify({ type, base_url }) !== JSON.stringify(provider))
      throw new ConfigError(
        "STACK_PROVIDER_TAKEN",
        `models.providers.${STACK_PROVIDER} already names another provider; rename it before running stack init.`,
      );
  } else doc.setIn(["models", "providers", STACK_PROVIDER], doc.createNode(provider));
  for (const [role, model] of Object.entries(input.roles))
    doc.setIn(["models", "roles", role], `${STACK_PROVIDER}/${withTag(model)}`);
  for (const [model, caps] of Object.entries(input.capabilities ?? {}))
    doc.setIn(
      ["models", "providers", STACK_PROVIDER, "models", withTag(model)],
      doc.createNode({
        tools: caps.tools,
        structured_output: true,
        vision: caps.vision,
        context_window: caps.context_window,
      }),
    );

  const configured = before.knowledge?.embedding;
  const embedding = typeof configured === "string" ? configured : DEFAULT_EMBEDDING;
  const alias = embedding.slice(0, embedding.indexOf("/"));
  const aliasType = before.models?.providers?.[alias]?.type;
  // `ollama/...` with no such provider is the built-in default: a local Ollama.
  if (alias !== STACK_PROVIDER && (aliasType === "ollama" || (alias === "ollama" && aliasType === undefined)))
    doc.setIn(["knowledge", "embedding"], `${STACK_PROVIDER}/${withTag(embedding.slice(alias.length + 1))}`);
  if (input.chroma) doc.setIn(["knowledge", "chroma", "url"], STACK_CHROMA_REF);
  return doc.toString();
}

/**
 * Every Ollama model the stack must pull for a project (REQ-GEN-10/AC3): the `stack/` models of `models.roles` and
 * of `knowledge.embedding`, sorted and without repeats.
 *
 * @param source - `qa.project.yaml` after {@link patchProjectForStack}.
 */
export function stackModels(source: string): string[] {
  const v = view(parseDocument(source));
  const prefix = `${STACK_PROVIDER}/`;
  const refs = [...Object.values(v.models?.roles ?? {}), v.knowledge?.embedding];
  return [
    ...new Set(
      refs
        .filter((r): r is string => typeof r === "string" && r.startsWith(prefix))
        .map((r) => r.slice(prefix.length)),
    ),
  ].sort();
}
