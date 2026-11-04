import type { AdapterDeps, DocumentSource } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeFetch, testDeps, type Route } from "../support/fake-fetch.js";

/** What a document source's fake server serves for the contract: one document with a known title and body. */
export interface DocumentSourceFixture {
  /** Routes of the fake server that list exactly one document and serve its body. */
  readonly routes: readonly Route[];
  readonly secrets: Readonly<Record<string, string>>;
  readonly expected: { readonly id: string; readonly title: string; readonly text: string };
}

/**
 * Contract of a {@link DocumentSource} (REQ-KNOW-12, REQ-GEN-11/AC11): it lists the documents with their versions
 * without bodies, loads a body on request, and a server error is an error, never an empty knowledge base.
 *
 * @param name - The source under test.
 * @param fixture - The fake server's content.
 * @param create - Builds the source with the given adapter dependencies.
 */
export function documentSourceContract(
  name: string,
  fixture: DocumentSourceFixture,
  create: (deps: AdapterDeps) => Promise<DocumentSource>,
): void {
  describe(`DocumentSource contract: ${name}`, () => {
    it("REQ-KNOW-12/AC1: lists the document with its version, then loads its body", async () => {
      const fake = createFakeFetch(fixture.routes);
      const source = await create(testDeps(fake.fetch, fixture.secrets));
      const docs = await source.list();
      expect(docs.map((d) => [d.id, d.title])).toEqual([[fixture.expected.id, fixture.expected.title]]);
      expect(docs[0]?.version).toBeTruthy();
      const doc = docs[0];
      if (!doc) throw new Error("no document listed");
      expect((await source.load(doc)).text).toContain(fixture.expected.text);
    });

    it("REQ-KNOW-12/AC1: a server error is an error, never an empty list", async () => {
      const fake = createFakeFetch([{ match: /.*/, reply: () => new Response("down", { status: 503 }) }]);
      const source = await create(testDeps(fake.fetch, fixture.secrets));
      await expect(source.list()).rejects.toThrow();
    });
  });
}
