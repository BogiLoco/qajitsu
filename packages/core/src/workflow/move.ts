import type { TicketKey } from "../identifiers.js";
import type { TicketWorkflow } from "../interfaces/ticket-workflow.js";

/** The outcome of moving a ticket to a status. */
export type MoveOutcome =
  | { readonly moved: true; readonly from: string; readonly to: string }
  | { readonly moved: false; readonly from: string; readonly to: string; readonly reason: string };

/**
 * Moves a ticket to a status through a transition its workflow offers (REQ-FLOW-02/AC3): a ticket already there stays;
 * a status no transition leads to leaves the ticket where it is with the reason, for a comment. Never throws for a
 * missing transition: the run's result is never lost over the ticket's status.
 *
 * @param workflow - The tracker's workflow.
 * @param ticket - The ticket.
 * @param to - The status name of the team (from `workflow.statuses`).
 */
export async function moveTicket(
  workflow: TicketWorkflow,
  ticket: TicketKey,
  to: string,
): Promise<MoveOutcome> {
  const from = await workflow.status(ticket);
  if (from.toLowerCase() === to.toLowerCase()) return { moved: true, from, to };
  const transitions = await workflow.transitions(ticket);
  const transition = transitions.find((t) => t.to.toLowerCase() === to.toLowerCase());
  if (!transition)
    return {
      moved: false,
      from,
      to,
      reason: `no transition from "${from}" to "${to}" (offered: ${transitions.map((t) => `"${t.to}"`).join(", ") || "none"})`,
    };
  await workflow.transition(ticket, transition.id);
  return { moved: true, from, to };
}
