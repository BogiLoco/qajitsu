import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fragment, type ContextFragment, type EventLog, type RunWorkspace } from "@qajitsu/core";
import type { ResolvedModel } from "@qajitsu/models";
import { z } from "zod";
import type { AssembledContext } from "./context-manager.js";
import { runStructuredAgent } from "./loop.js";
import type { UsageTracker } from "./usage.js";

/** Version of the summary prompt; part of every summary's cache key (REQ-CTX-17/AC2). */
export const SUMMARY_VERSION = "2026-10-29.1";

/** Instructions of the summary role (REQ-CTX-14/AC5). */
export const SUMMARY_SYSTEM = `You shorten one piece of the context of a QA task for another model that cannot read it in full.
Keep exactly, character for character: numbers, amounts, identifiers, endpoints, URLs, selectors, error codes and
messages, and every quoted expectation. Keep the structure (which file, which step, which request). Leave out
repetition and boilerplate, and say in one line what kind of material you left out. Never add facts, judgements or
advice. Answer with one JSON object only: {"summary": "..."}`;

const SummarySchema = z.strictObject({ summary: z.string().min(1).max(8_000) });

/** A cached summary: the answer with the model, prompt version and source it was written for. */
const CachedSchema = SummarySchema.extend({
  model: z.string(),
  version: z.string(),
  source: z.string(),
  sha256: z.string(),
});

/** When summaries by a model may be used (REQ-CTX-14/AC5): never, for roles that cannot read handles, or always. */
export type SummaryPolicy = "off" | "no-tools" | "allowed";

/**
 * A summary of one fragment (REQ-CTX-14/AC5, REQ-CTX-17/AC2): from the run's cache when the same fragment was
 * summarised by the same model and prompt version, otherwise written by the summary role and cached. The summary is
 * untrusted data like its source and names the model that wrote it.
 *
 * @param deps - The run's workspace, journal and usage.
 * @param input - The summary model, the fragment and how a call's input is assembled.
 * @returns The summary fragment, or undefined when the summary role could not write one (the fragment then stays
 *   behind its handle).
 */
export async function summarise(
  deps: {
    readonly ws: RunWorkspace;
    readonly events: EventLog;
    readonly usage: UsageTracker;
    readonly signal?: AbortSignal;
  },
  input: {
    readonly stage: string;
    readonly model: ResolvedModel;
    readonly fragment: ContextFragment;
    readonly assemble: (fragments: readonly ContextFragment[]) => Promise<AssembledContext>;
  },
): Promise<ContextFragment | undefined> {
  const f = input.fragment;
  const key = createHash("sha256").update(`${f.sha256}|${input.model.id}|${SUMMARY_VERSION}`).digest("hex");
  const file = deps.ws.path("context", "summaries", `${key}.json`);
  const actor = { kind: "agent", name: "summary" } as const;
  let summary: string | undefined;
  let cached = false;
  try {
    summary = CachedSchema.parse(JSON.parse(await readFile(file, "utf8"))).summary;
    cached = true;
  } catch {
    try {
      const context = await input.assemble([
        fragment({
          kind: "role-instructions",
          source: "summary",
          trust: "trusted",
          section: "stable",
          priority: 100,
          pinned: true,
          text: SUMMARY_SYSTEM,
        }),
        { ...f, pinned: true },
        fragment({
          kind: "question",
          source: "question",
          trust: "trusted",
          section: "varying",
          priority: 0,
          pinned: true,
          text: `Shorten the data block ${f.source} above to at most a quarter of its length and answer with the JSON object.`,
        }),
      ]);
      const { value } = await runStructuredAgent({
        stage: input.stage,
        role: "summary",
        model: input.model,
        context,
        schema: SummarySchema,
        validate: (answer) =>
          answer.summary.length >= f.text.length * 0.6
            ? ["the summary must be much shorter than the text"]
            : [],
        usage: deps.usage,
        ...(deps.signal ? { signal: deps.signal } : {}),
      });
      summary = value.summary;
      await mkdir(dirname(file), { recursive: true });
      await writeFile(
        file,
        `${JSON.stringify({ summary, model: input.model.id, version: SUMMARY_VERSION, source: f.source, sha256: f.sha256 }, null, 2)}\n`,
        "utf8",
      );
    } catch (error) {
      deps.events.emit(input.stage, actor, "context.summary_failed", {
        source: f.source,
        sha256: f.sha256,
        model: input.model.id,
        reason: error instanceof Error ? error.message.slice(0, 300) : "unknown",
      });
      return undefined;
    }
  }
  deps.events.emit(input.stage, actor, "context.summarised", {
    source: f.source,
    sha256: f.sha256,
    model: input.model.id,
    version: SUMMARY_VERSION,
    cached,
  });
  return fragment({
    kind: f.kind,
    source: `${f.source} (summary)`,
    trust: "untrusted",
    section: f.section,
    priority: f.priority,
    pinned: false,
    text: `${summary}\n[summary of ${f.source} written by ${input.model.id}; details may be missing]`,
  });
}
