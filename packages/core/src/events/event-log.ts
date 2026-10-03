import { appendFileSync } from "node:fs";
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
});

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
}): EventLog {
  const { ticket, run, write, now, mask } = options;
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
      });
      write(`${JSON.stringify(line)}\n`);
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
