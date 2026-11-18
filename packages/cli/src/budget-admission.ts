import { join } from "node:path";
import {
  checkBudget,
  fileSpendLedger,
  monthOf,
  SPEND_LEDGER_FILE,
  sumSpend,
  type BudgetStop,
} from "@qajitsu/core";
import { assertLedgerMatches } from "./budget-ledger.js";
import type { LoadedProject } from "./project.js";
import type { RunSession } from "./session.js";

/**
 * Whether a new run may start (REQ-FLOW-06/AC5): the month's budget is checked before a run exists, the ticket's
 * once its content version is known. A scope at its limit starts nothing.
 *
 * @param project - The project and its budgets.
 * @param root - The project's runs root (the ledger is under it).
 * @param now - The command's clock, for the calendar month.
 * @param ticket - The ticket and its content version; without them only the month is checked.
 * @returns The stop, or undefined when the run may start.
 * @throws BudgetError `LEDGER_INVALID` or `LEDGER_MISMATCH` when the ledger cannot be trusted: no new work until it
 *   is rebuilt.
 */
export async function budgetAdmission(
  project: LoadedProject,
  root: string,
  now: () => Date,
  ticket?: { readonly key: string; readonly version: string },
): Promise<BudgetStop | undefined> {
  const { budget } = project.config;
  if (budget.month === undefined && budget.ticket === undefined) return undefined;
  // REQ-FLOW-06/AC2: a ledger the journals do not prove starts nothing; checked once, before the run exists.
  if (ticket === undefined) await assertLedgerMatches(project, root);
  if (budget.month === undefined && ticket === undefined) return undefined;
  const entries = await fileSpendLedger(join(root, SPEND_LEDGER_FILE)).read();
  const period = monthOf(now(), budget.time_zone);
  const empty = { costUsd: 0, unpricedCalls: 0, tokens: 0, activeMs: 0 };
  return checkBudget(
    // Only the scopes this moment can judge; the run's own limits apply inside the run.
    {
      time_zone: budget.time_zone,
      ...(budget.month ? { month: budget.month } : {}),
      ...(ticket && budget.ticket ? { ticket: budget.ticket } : {}),
    },
    {
      ticket: ticket ? sumSpend(entries, { ticket: ticket.key, ticketVersion: ticket.version }) : empty,
      month: sumSpend(entries, { month: period, timeZone: budget.time_zone }),
    },
    { period },
  );
}

/**
 * Refuses a command that spends under a ticket or month budget while the ledger cannot be trusted
 * (REQ-FLOW-06/AC2): a ledger deleted or edited after the run was fetched stops the next plan, run or exploration.
 *
 * @param session - The run and its project.
 * @throws BudgetError `LEDGER_INVALID` or `LEDGER_MISMATCH`.
 */
export async function assertLedgerTrusted(session: Pick<RunSession, "ws" | "project">): Promise<void> {
  const { budget } = session.project.config;
  if (budget.ticket === undefined && budget.month === undefined) return;
  await assertLedgerMatches(session.project, session.ws.root);
}
