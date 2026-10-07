import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventLog, Plan } from "@qajitsu/core";
import type { CommandIO } from "./fetch.js";

type Listener = (event: string, details: Readonly<Record<string, unknown>>) => void;

/**
 * An event log that also tells `listener` about every event it writes, after writing it (REQ-OBS-09).
 *
 * @param events - The run's journal.
 * @param listener - Called with the event name and its details.
 */
export function teeEvents(events: EventLog, listener: Listener): EventLog {
  return {
    ...events,
    emit(stage, actor, event, details) {
      events.emit(stage, actor, event, details);
      try {
        listener(event, (details ?? {}) as Readonly<Record<string, unknown>>);
      } catch {
        // Showing progress never affects the run.
      }
    },
  };
}

const clock = (ms: number): string => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/**
 * Prints the progress of `qj run` as plain lines, in a terminal and in CI alike (REQ-OBS-09/AC1): when a case starts
 * (with its number), each step as it starts, and how each attempt ended. Attempt outcomes are not statuses; the
 * statuses are computed after the run.
 *
 * @param io - Where to print.
 * @param plan - The approved plan (step actions).
 * @param total - Cases this run executes.
 * @param now - Clock in ms.
 * @param startedAt - When the run started (ms).
 */
export function createProgressPrinter(
  io: CommandIO,
  plan: Plan,
  total: number,
  now: () => number,
  startedAt: number,
): Listener {
  const order = new Map<string, number>();
  const attemptStart = new Map<string, number>();
  const action = (caseId: string, stepId: string): string => {
    const text = plan.cases.find((c) => c.id === caseId)?.steps.find((s) => s.id === stepId)?.action ?? "";
    return text.length > 80 ? `${text.slice(0, 79)}…` : text;
  };
  return (event, d) => {
    const caseId = typeof d["caseId"] === "string" ? d["caseId"] : undefined;
    if (caseId === undefined) return;
    const at = `[${clock(now() - startedAt)}]`;
    const attempt = typeof d["attempt"] === "number" ? d["attempt"] : 1;
    if (event === "case.attempt.start") {
      if (!order.has(caseId)) order.set(caseId, order.size + 1);
      attemptStart.set(caseId, now());
      io.write(
        `${at} ▶ ${caseId} (${String(order.get(caseId))}/${String(total)})${attempt > 1 ? ` attempt ${String(attempt)}` : ""}\n`,
      );
    } else if (event === "step.start" && typeof d["step"] === "string") {
      io.write(`${at}   ${caseId} ${d["step"]}: ${action(caseId, d["step"])}\n`);
    } else if (event === "case.attempt.end") {
      const took = (now() - (attemptStart.get(caseId) ?? now())) / 1000;
      io.write(
        `${at} ■ ${caseId} attempt ${String(attempt)}: ${String(d["outcome"])} (${took.toFixed(1)} s)\n`,
      );
    }
  };
}

/**
 * Keeps the latest screenshot of each case in `<run>/live/<case>.png` for `qj watch` (REQ-OBS-09/AC2). These are
 * previews written by the trusted parent, not evidence; evidence is stored with its hash as before.
 */
export function liveScreenshots(dir: string): (caseId: string, stepId: string, png: Uint8Array) => void {
  let queue: Promise<void> = Promise.resolve();
  return (caseId, _stepId, png) => {
    if (!/^TC-\d{2,4}$/.test(caseId)) return;
    queue = queue
      .then(async () => {
        await mkdir(dir, { recursive: true });
        const file = join(dir, `${caseId}.png`);
        await writeFile(`${file}.tmp`, png);
        await rename(`${file}.tmp`, file);
      })
      .catch(() => undefined);
  };
}
