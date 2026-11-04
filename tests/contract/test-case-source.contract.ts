import { TicketKeySchema, type AdapterDeps, type TestCaseSource } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeFetch, testDeps, type Route } from "../support/fake-fetch.js";

/** What a test-case source's fake server serves for the contract: the cases linked to one ticket. */
export interface TestCaseSourceFixture {
  readonly routes: readonly Route[];
  readonly secrets: Readonly<Record<string, string>>;
  readonly ticket: string;
  /** The ids of the imported cases, `<system>:<id>`, in order. */
  readonly expectedIds: readonly string[];
}

/**
 * Contract of a {@link TestCaseSource} (REQ-CTX-08, REQ-GEN-11/AC11): the cases linked to a ticket come back as
 * valid imported cases of the source's system, and a server error is an error, never "no cases".
 *
 * @param name - The source under test.
 * @param fixture - The fake server's content.
 * @param create - Builds the source with the given adapter dependencies.
 */
export function testCaseSourceContract(
  name: string,
  fixture: TestCaseSourceFixture,
  create: (deps: AdapterDeps) => Promise<TestCaseSource>,
): void {
  describe(`TestCaseSource contract: ${name}`, () => {
    it("REQ-CTX-08/AC1: returns the cases linked to the ticket as imported cases of its system", async () => {
      const fake = createFakeFetch(fixture.routes);
      const source = await create(testDeps(fake.fetch, fixture.secrets));
      const cases = await source.findCases(TicketKeySchema.parse(fixture.ticket));
      expect(cases.map((c) => c.id)).toEqual(fixture.expectedIds);
      for (const c of cases) expect(c.system).toBe(source.system);
    });

    it("REQ-CTX-08/AC4: a server error is an error, never an empty list", async () => {
      const fake = createFakeFetch([{ match: /.*/, reply: () => new Response("down", { status: 503 }) }]);
      const source = await create(testDeps(fake.fetch, fixture.secrets));
      await expect(source.findCases(TicketKeySchema.parse(fixture.ticket))).rejects.toThrow();
    });
  });
}
