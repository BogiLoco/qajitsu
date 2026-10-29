import { createHash } from "node:crypto";
import type { ContextSnapshot } from "@qajitsu/core";
import type { ModelMessage } from "ai";

/** One compaction of a tool result, recorded like every other reduction (REQ-CTX-16/AC3). */
export type Compaction = ContextSnapshot["reductions"][number] & { readonly action: "compacted" };

const NOTE = "[compacted by QAJitsu:";

/** Estimated tokens of a conversation: four characters per token, as every other estimate. */
export function messagesTokens(system: string, messages: readonly ModelMessage[]): number {
  let chars = system.length;
  for (const m of messages)
    if (typeof m.content === "string") chars += m.content.length;
    else
      for (const part of m.content)
        chars +=
          part.type === "text"
            ? part.text.length
            : part.type === "file"
              ? 1_000
              : JSON.stringify(part).length;
  return Math.ceil(chars / 4);
}

const outputText = (output: unknown): string | undefined => {
  if (typeof output !== "object" || output === null) return undefined;
  const o = output as { type?: unknown; value?: unknown };
  if (o.type === "text" || o.type === "error-text") return typeof o.value === "string" ? o.value : undefined;
  if (o.type === "json" || o.type === "error-json") return JSON.stringify(o.value);
  return undefined;
};

/** String values of a tool call's input: what a later turn may name to cite its result (a path, a query). */
const inputValues = (input: unknown): string[] =>
  typeof input === "string"
    ? [input]
    : typeof input === "object" && input !== null
      ? Object.values(input).flatMap(inputValues)
      : [];

/**
 * Compacts an agent loop's conversation only when it does not fit its budget (REQ-CTX-16/AC1): the oldest tool results
 * that the loop no longer refers to are replaced by a one-line description built by code, with the full text kept
 * behind a handle (AC2). The first message (the assembled input, with every pinned fragment), the last results and
 * every result whose call the latest assistant turn names stay whole (AC2, AC3). Returns undefined when nothing changed.
 *
 * @param messages - The conversation the next step would send.
 * @param options - The system message, the budget with its margin, how to keep a full text behind a handle (or
 *   undefined when the role cannot read handles: then the note says to call the tool again), and how many of the last
 *   results stay whole.
 */
export function compactMessages(
  messages: readonly ModelMessage[],
  options: {
    readonly system: string;
    readonly budget: number;
    readonly margin: number;
    readonly keep?: ((toolName: string, text: string) => string) | undefined;
    readonly keepLast?: number;
  },
): { readonly messages: ModelMessage[]; readonly compactions: Compaction[] } | undefined {
  const cost = (ms: readonly ModelMessage[]): number =>
    Math.ceil(messagesTokens(options.system, ms) * options.margin);
  if (cost(messages) <= options.budget) return undefined;
  // Tool calls by id, for their inputs; the latest assistant turn's text and calls, for what it still refers to.
  const calls = new Map<string, unknown>();
  let latest = "";
  for (const m of messages)
    if (m.role === "assistant" && typeof m.content !== "string") {
      latest = "";
      for (const part of m.content) {
        if (part.type === "tool-call") {
          calls.set(part.toolCallId, part.input);
          latest += `\n${JSON.stringify(part.input)}`;
        } else if (part.type === "text") latest += `\n${part.text}`;
      }
    }
  const results: { m: number; p: number; id: string }[] = [];
  messages.forEach((m, i) => {
    if (i === 0 || m.role !== "tool") return;
    m.content.forEach((part, p) => {
      if (part.type === "tool-result") results.push({ m: i, p, id: part.toolCallId });
    });
  });
  const candidates = results.slice(0, Math.max(0, results.length - (options.keepLast ?? 2))).filter((r) => {
    const values = inputValues(calls.get(r.id)).filter((v) => v.length >= 4);
    return !values.some((v) => latest.includes(v));
  });
  const out = messages.map((m) => (m.role === "tool" ? { ...m, content: [...m.content] } : m));
  const compactions: Compaction[] = [];
  for (const r of candidates) {
    if (cost(out) <= options.budget) break;
    const message = out[r.m];
    if (message?.role !== "tool") continue;
    const part = message.content[r.p];
    if (part?.type !== "tool-result") continue;
    const text = outputText(part.output);
    if (text === undefined || text.startsWith(NOTE) || text.length < 400) continue;
    const handle = options.keep?.(part.toolName, text);
    const args = inputValues(calls.get(r.id)).join(", ").slice(0, 120);
    const note = `${NOTE} ${part.toolName}(${args}) returned ${String(text.length)} characters, left out to fit the budget; ${handle ? `the full result is ${handle}, read it with read_context` : "call the tool again if you need it"}]`;
    message.content[r.p] = { ...part, output: { type: "text", value: note } };
    compactions.push({
      sha256: createHash("sha256").update(text).digest("hex"),
      action: "compacted",
      reason: `loop over budget: ${part.toolName} result of an earlier step${handle ? ` behind ${handle}` : ""}`,
      tokensSaved: Math.max(0, Math.ceil((text.length - note.length) / 4)),
    });
  }
  return compactions.length === 0 ? undefined : { messages: out, compactions };
}
