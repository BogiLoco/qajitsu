/** One line of `journal/events.jsonl` (REQ-VER-04, REQ-OBS-01). */
export interface JournalEvent {
  readonly ts: string;
  readonly run: string;
  readonly stage: string;
  readonly event: "tool_allowed" | "tool_denied" | "tool_result";
  readonly tool: string;
  readonly code?: string;
  readonly reason?: string;
  /** Masked and truncated tool arguments (REQ-VER-04/AC2). */
  readonly args?: unknown;
  /** Masked and truncated result summary (REQ-VER-04/AC2). */
  readonly result?: string;
}

/** Append-only journal of agent tool calls. */
export interface Journal {
  record(event: Omit<JournalEvent, "ts">): void;
}

/** Strings in journaled arguments and results are cut to this many characters. */
export const JOURNAL_MAX_STRING = 500;

const truncate = (text: string): string =>
  text.length > JOURNAL_MAX_STRING
    ? `${text.slice(0, JOURNAL_MAX_STRING)}…(${String(text.length)} chars)`
    : text;

const shorten = (value: unknown): unknown => {
  if (typeof value === "string") return truncate(value);
  if (Array.isArray(value)) return value.map(shorten);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shorten(v)]));
  }
  return value;
};

/**
 * Creates a journal that serialises each event as one JSON line. Arguments and results pass
 * through `mask` before anything is written (invariant 8), then long strings are truncated.
 *
 * @param write - Sink for complete lines (file append in production, array push in tests).
 * @param now - Clock, injected for deterministic tests.
 * @param mask - Masker for values, normally `masker.maskJson` from `@qajitsu/steps`.
 */
export function createJournal(
  write: (line: string) => void,
  now: () => Date,
  mask: (value: unknown) => unknown,
): Journal {
  return {
    record(event) {
      const { args, result, reason, ...rest } = event;
      const line: Record<string, unknown> = { ts: now().toISOString(), ...rest };
      if (reason !== undefined) line["reason"] = String(mask(reason));
      if (args !== undefined) line["args"] = shorten(mask(args));
      if (result !== undefined) line["result"] = truncate(String(mask(result)));
      write(`${JSON.stringify(line)}\n`);
    },
  };
}
