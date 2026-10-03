/** One line of `journal/events.jsonl` (REQ-VER-04, REQ-OBS-01). */
export interface JournalEvent {
  readonly ts: string;
  readonly run: string;
  readonly stage: string;
  readonly event: "tool_allowed" | "tool_denied";
  readonly tool: string;
  readonly code?: string;
  readonly reason?: string;
}

/** Append-only journal of agent tool calls. */
export interface Journal {
  record(event: Omit<JournalEvent, "ts">): void;
}

/**
 * Creates a journal that serialises each event as one JSON line.
 *
 * @param write - Sink for complete lines (file append in production, array push in tests).
 * @param now - Clock, injected for deterministic tests.
 */
export function createJournal(write: (line: string) => void, now: () => Date): Journal {
  return {
    record(event) {
      write(`${JSON.stringify({ ts: now().toISOString(), ...event })}\n`);
    },
  };
}
