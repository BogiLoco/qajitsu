import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { z } from "zod";

/** Who caused an event (REQ-OBS-01/AC2). */
export const ActorSchema = z.strictObject({
  kind: z.enum(["agent", "runner", "user", "system"]),
  /** Agent role (`planner`), runner kind (`api`), user name or component (`orchestrator`). */
  name: z.string().min(1),
});

/** Who caused an event. */
export type Actor = z.infer<typeof ActorSchema>;

/** One line of `journal/events.jsonl` written by the orchestrator, runners and humans (REQ-OBS-01). */
export const RunEventSchema = z.strictObject({
  ts: z.string(),
  run: z.string(),
  ticket: z.string(),
  stage: z.string(),
  actor: ActorSchema,
  event: z.string().regex(/^[a-z][a-z0-9_.]*$/),
  details: z.unknown().optional(),
  /** SHA-256 of the previous line of the journal (hash chain, REQ-OBS-05); 64 zeros for the first line. */
  prev: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
});

/** `prev` of the first line of a journal. */
export const GENESIS_HASH = "0".repeat(64);

const lineHash = (line: string): string => createHash("sha256").update(line, "utf8").digest("hex");

/**
 * Hash the next line of a journal file must carry as `prev`: SHA-256 of its last line, or
 * {@link GENESIS_HASH} for a new or empty journal. Lets every process continue the same chain.
 *
 * @param file - `journal/events.jsonl`.
 */
export function journalTailHash(file: string): string {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return GENESIS_HASH;
  }
  const last = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .at(-1);
  return last === undefined ? GENESIS_HASH : lineHash(last);
}

/**
 * Anchor of a journal recorded in `run.json` (REQ-OBS-05): its number of lines and the hash of the last
 * one. A later check that finds fewer lines or a different line at that position detects a cut or
 * rewritten journal. It does not stop someone who can rewrite both files; that needs a signing key.
 *
 * @param text - Content of `events.jsonl`.
 */
export function journalAnchor(text: string): { readonly lines: number; readonly tail: string } {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  const last = lines.at(-1);
  return { lines: lines.length, tail: last === undefined ? GENESIS_HASH : lineHash(last) };
}

/**
 * Checks a journal against its hash chain and an anchor recorded earlier (REQ-OBS-05/AC1). Journals
 * written before the chain existed (no line has `prev`) are reported as legacy, not as broken.
 *
 * @returns Problems; empty when intact.
 */
export function checkJournal(
  text: string,
  anchor?: { readonly lines: number; readonly tail: string },
): { readonly problems: string[]; readonly legacy: boolean } {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return { problems: ["journal is missing or empty"], legacy: false };
  const chained = lines.some((l) => l.includes('"prev":"'));
  if (!chained && anchor === undefined) return { problems: [], legacy: true };
  const problems = verifyEventChain(text).map((b) => `line ${String(b.line)}: ${b.reason}`);
  if (anchor) {
    const at = lines[anchor.lines - 1];
    if (lines.length < anchor.lines)
      problems.push(`journal has ${String(lines.length)} lines, ${String(anchor.lines)} were recorded`);
    else if (at === undefined || lineHash(at) !== anchor.tail)
      problems.push(`line ${String(anchor.lines)} differs from the recorded anchor`);
  }
  return { problems, legacy: false };
}

/**
 * Verifies the hash chain of a journal (REQ-OBS-05/AC1): every line must name the SHA-256 of the line
 * before it. An edited, removed, reordered or inserted line breaks the chain at that point.
 *
 * @param text - Content of `events.jsonl`.
 * @returns 1-based line numbers where the chain breaks, with the reason; empty when intact.
 */
export function verifyEventChain(text: string): { line: number; reason: string }[] {
  const breaks: { line: number; reason: string }[] = [];
  let expected = GENESIS_HASH;
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    let prev: unknown;
    try {
      prev = (JSON.parse(raw) as { prev?: unknown }).prev;
    } catch {
      breaks.push({ line: i + 1, reason: "not valid JSON" });
    }
    if (prev === undefined) breaks.push({ line: i + 1, reason: "no hash of the previous line" });
    else if (prev !== expected) breaks.push({ line: i + 1, reason: "does not match the previous line" });
    expected = lineHash(raw);
  });
  return breaks.filter((b, i, all) => all.findIndex((x) => x.line === b.line) === i);
}

/** Parsed event line. */
export type RunEvent = z.infer<typeof RunEventSchema>;

/** Append-only structured event log of one run. */
export interface EventLog {
  /**
   * Appends one event; `details` are masked before they are written (invariant 8).
   *
   * @param stage - Pipeline stage, e.g. `fetch`, `plan`, `run`.
   * @param actor - Who caused the event.
   * @param event - Dotted lowercase name, e.g. `stage.start`, `ticket.fetched`, `model.usage`.
   * @param details - Structured details; secrets are masked.
   */
  emit(stage: string, actor: Actor, event: string, details?: unknown): void;
}

/**
 * Creates the event log of one run (REQ-OBS-01).
 *
 * @param options - Run identity, line sink, clock and masker.
 * @example
 * const log = createEventLog({ ticket, run: ws.runId, write: fileSink(ws.path("journal", "events.jsonl")), now, mask });
 * log.emit("fetch", { kind: "system", name: "orchestrator" }, "stage.start");
 */
export function createEventLog(options: {
  readonly ticket: string;
  readonly run: string;
  readonly write: (line: string) => void;
  readonly now: () => Date;
  readonly mask: (value: unknown) => unknown;
  /** Continues a hash chain from this hash (see {@link journalTailHash}); without it lines are not chained. */
  readonly previousHash?: string | undefined;
  /**
   * Reads the chain's current tail before every line, so several processes appending to one journal
   * keep a single chain; takes precedence over `previousHash`.
   */
  readonly tail?: (() => string) | undefined;
}): EventLog {
  const { ticket, run, write, now, mask } = options;
  let previous = options.previousHash;
  return {
    emit(stage, actor, event, details) {
      const line = RunEventSchema.parse({
        ts: now().toISOString(),
        run,
        ticket,
        stage,
        actor,
        event,
        ...(details === undefined ? {} : { details: mask(details) }),
        ...(options.tail ? { prev: options.tail() } : previous === undefined ? {} : { prev: previous }),
      });
      const text = JSON.stringify(line);
      if (previous !== undefined) previous = lineHash(text);
      write(`${text}\n`);
    },
  };
}

/**
 * Line sink that appends synchronously to a file, so event order on disk matches emit order.
 *
 * @param file - Absolute path, normally `<run>/journal/events.jsonl`.
 */
export function fileSink(file: string): (line: string) => void {
  return (line) => {
    appendFileSync(file, line, "utf8");
  };
}

/**
 * Parses an `events.jsonl` text; invalid lines are reported, not skipped silently.
 *
 * @param text - File content.
 * @returns Parsed events and the 1-based numbers of invalid lines.
 */
export function parseEventLines(text: string): { events: RunEvent[]; invalidLines: number[] } {
  const events: RunEvent[] = [];
  const invalidLines: number[] = [];
  text.split("\n").forEach((raw, i) => {
    if (raw.trim() === "") return;
    try {
      const parsed = RunEventSchema.safeParse(JSON.parse(raw));
      if (parsed.success) events.push(parsed.data);
      else invalidLines.push(i + 1);
    } catch {
      invalidLines.push(i + 1);
    }
  });
  return { events, invalidLines };
}
