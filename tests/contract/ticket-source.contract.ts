import { TicketKeySchema, type TicketSource } from "@qajitsu/core";
import { describe, expect, it } from "vitest";

/**
 * Shared contract of every TicketSource (REQ-CTX-01, REQ-GEN-02). The factory must serve ticket
 * `known` (with at least one acceptance criterion and one comment) and fail for `missing`.
 */
export function ticketSourceContract(
  name: string,
  create: () => TicketSource,
  keys: { readonly known: string; readonly missing: string },
): void {
  describe(`TicketSource contract: ${name}`, () => {
    it("REQ-CTX-01/AC1: returns summary, description, criteria, comments, links and attachments", async () => {
      const ticket = await create().getTicket(TicketKeySchema.parse(keys.known));
      expect(ticket.key).toBe(keys.known);
      expect(ticket.summary.length).toBeGreaterThan(0);
      expect(ticket.acceptanceCriteria.length).toBeGreaterThan(0);
      expect(ticket.comments.length).toBeGreaterThan(0);
      expect(Array.isArray(ticket.linkedKeys)).toBe(true);
      expect(Array.isArray(ticket.attachments)).toBe(true);
      expect(Array.isArray(ticket.developmentLinks)).toBe(true);
      expect(JSON.parse(JSON.stringify(ticket))).toEqual(ticket);
    });

    it("REQ-CTX-01/AC3: rejects malformed keys before doing any work", async () => {
      await expect(create().getTicket("../../etc/passwd" as never)).rejects.toThrow(/Jira key/);
    });

    it("REQ-CTX-01/AC5: a ticket that cannot be fetched fails with an adapter error", async () => {
      await expect(create().getTicket(TicketKeySchema.parse(keys.missing))).rejects.toMatchObject({
        name: "AdapterError",
      });
    });
  });
}
