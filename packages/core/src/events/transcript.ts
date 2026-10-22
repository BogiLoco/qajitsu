import { sha256 } from "../plan/plan-store.js";

/** Path of the agent transcript inside a run folder (REQ-VER-16/AC2). */
export const AGENT_TRANSCRIPT_FILE = "journal/agents.jsonl";

/** One model call of an agent: what was sent, what came back, and what it cost. */
export interface ModelExchange {
  readonly stage: string;
  readonly role: string;
  /** `<provider>/<model>` as configured. */
  readonly model: string;
  /** Provider and model id the provider reported, when it did. */
  readonly provider?: string | undefined;
  readonly modelVersion?: string | undefined;
  /** System prompt and messages as sent; binary parts are replaced by their SHA-256 and size. */
  readonly request: unknown;
  /** Final text and every step's tool calls (arguments) and tool results. */
  readonly response: unknown;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** Records one exchange and returns the SHA-256 of the stored line, which the journal keeps. */
export type TranscriptRecorder = (exchange: ModelExchange) => {
  readonly sha256: string;
  readonly seq: number;
};

/**
 * Creates the agent transcript of a run (REQ-VER-16/AC2+AC3): one JSON line per model call in
 * `journal/agents.jsonl`, masked before it is written. The returned hash covers exactly the stored line, and the
 * journal's `model.usage` event carries it, so the hash chain of the journal also protects the transcript while the
 * journal itself stays small.
 *
 * @param options - Line sink, masker and clock.
 */
export function createTranscript(options: {
  readonly write: (line: string) => void;
  readonly mask: (value: unknown) => unknown;
  readonly now: () => Date;
  /** Number of the first line this recorder writes, after those earlier processes wrote. */
  readonly firstSeq?: number;
}): TranscriptRecorder {
  let seq = (options.firstSeq ?? 1) - 1;
  return (exchange) => {
    seq += 1;
    const line = JSON.stringify(options.mask({ ts: options.now().toISOString(), seq, ...exchange }));
    options.write(`${line}\n`);
    return { sha256: sha256(line), seq };
  };
}

/**
 * Checks the transcript against the journal (REQ-VER-16/AC4): every model call in the journal must point to a stored
 * exchange with the same hash, and every stored exchange must be referenced. A model call recorded without a
 * transcript (runs from before it existed) is a gap too.
 *
 * @param events - Content of `journal/events.jsonl`.
 * @param transcript - Content of `journal/agents.jsonl`, or nothing when it is missing.
 * @returns Problems; empty when the transcript is complete.
 */
export function checkTranscript(events: string, transcript: string | undefined): string[] {
  const calls: { line: number; sha?: string }[] = [];
  events.split("\n").forEach((raw, i) => {
    if (!raw.includes('"model.usage"')) return;
    try {
      const e = JSON.parse(raw) as { event?: string; details?: { exchangeSha256?: unknown } };
      if (e.event !== "model.usage") return;
      const sha = e.details?.exchangeSha256;
      calls.push({ line: i + 1, ...(typeof sha === "string" ? { sha } : {}) });
    } catch {
      // A broken journal line is reported by the hash chain check.
    }
  });
  if (calls.length === 0) return [];
  if (transcript === undefined)
    return [`${AGENT_TRANSCRIPT_FILE} is missing (${String(calls.length)} model calls)`];
  const stored = new Map<string, number>();
  transcript.split("\n").forEach((raw, i) => {
    if (raw.trim() !== "") stored.set(sha256(raw), i + 1);
  });
  const referenced = new Set<string>();
  const problems: string[] = [];
  for (const c of calls) {
    if (c.sha === undefined) {
      problems.push(`journal line ${String(c.line)}: model call without a recorded prompt and answer`);
      continue;
    }
    referenced.add(c.sha);
    if (!stored.has(c.sha))
      problems.push(
        `journal line ${String(c.line)}: model exchange ${c.sha.slice(0, 12)} is not in ${AGENT_TRANSCRIPT_FILE}`,
      );
  }
  for (const [sha, line] of stored)
    if (!referenced.has(sha))
      problems.push(`${AGENT_TRANSCRIPT_FILE} line ${String(line)}: not referenced by the journal`);
  return problems;
}
