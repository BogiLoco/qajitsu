/** Whether a new run of a ticket may start (REQ-FLOW-05). */
export type Admission =
  | { readonly admit: true }
  | { readonly admit: false; readonly reason: "active"; readonly runId: string }
  | { readonly admit: false; readonly reason: "daily_limit"; readonly today: number; readonly limit: number };

/**
 * Decides whether a new run of a ticket may start in the team's workflow (REQ-FLOW-05/AC1+AC2): never while another run
 * of it is active (a duplicate event is ignored), and not more than `maxPerDay` runs a day (UTC); after that the
 * ticket needs a person.
 *
 * @param runs - The ticket's runs with their creation time and whether a live process holds them.
 * @param now - The current time.
 * @param maxPerDay - Runs allowed per ticket and day.
 */
export function admitRun(
  runs: readonly { readonly runId: string; readonly createdAt: string; readonly active: boolean }[],
  now: Date,
  maxPerDay: number,
): Admission {
  const active = runs.find((r) => r.active);
  if (active) return { admit: false, reason: "active", runId: active.runId };
  const day = now.toISOString().slice(0, 10);
  const today = runs.filter((r) => r.createdAt.slice(0, 10) === day).length;
  if (today >= maxPerDay) return { admit: false, reason: "daily_limit", today, limit: maxPerDay };
  return { admit: true };
}
