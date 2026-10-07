import type { ImportedCase } from "../context/imported-cases.js";
import type { TicketKey } from "../identifiers.js";

/**
 * Reads the manual test cases linked to a ticket from a test management tool (Xray, Zephyr Scale, TestRail) or a
 * CSV/Excel file (REQ-CTX-08/AC1). The cases are an extra, untrusted planner source.
 */
export interface TestCaseSource {
  readonly system: ImportedCase["system"];
  /**
   * The cases linked to the ticket.
   *
   * @throws {AdapterError} when the source cannot be reached or answers malformed data.
   */
  findCases(ticket: TicketKey, signal?: AbortSignal): Promise<readonly ImportedCase[]>;
}
