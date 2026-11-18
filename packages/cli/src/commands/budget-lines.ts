import type { RunEvent } from "@qajitsu/core";

/**
 * The budget section of a run's ticket comment (REQ-FLOW-06/AC8): the ticket or month stop recorded by code in the
 * journal, and the cases it left NOT_RUN or BLOCKED, with their computed statuses. Empty when no such budget stopped
 * work in the run.
 *
 * @param events - The run's journal.
 * @param cases - Every case with its computed status and the reason of its last attempt.
 * @returns The lines, in order: the stop, the cases it stopped, the note on finished results.
 */
export function budgetLines(
  events: readonly RunEvent[],
  cases: readonly {
    readonly caseId: string;
    readonly status: string;
    readonly reason?: string | undefined;
  }[],
): string[] {
  const stops = events.flatMap((e) => {
    if (e.event !== "budget.exceeded") return [];
    const d = e.details as Record<string, unknown> | undefined;
    return d && (d["scope"] === "ticket" || d["scope"] === "month") && typeof d["reason"] === "string"
      ? [d["reason"]]
      : [];
  });
  const first = stops[0];
  if (first === undefined) return [];
  const reasons = new Set(stops);
  const stopped = cases.filter(
    (c) =>
      (c.status === "NOT_RUN" || c.status === "BLOCKED") &&
      c.reason !== undefined &&
      [...reasons].some((r) => c.reason?.includes(r) === true),
  );
  const finished = cases.length - stopped.length;
  return [
    `Work stopped: ${first}.`,
    stopped.length > 0
      ? `Not tested because of it: ${stopped.map((c) => `${c.caseId} ${c.status}`).join(", ")}.`
      : "No case was left untested because of it.",
    `The other ${String(finished)} of ${String(cases.length)} case(s) have their computed results above.`,
  ];
}
