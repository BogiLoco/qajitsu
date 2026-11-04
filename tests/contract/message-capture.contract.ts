import type { AdapterDeps, MessageCapture } from "@qajitsu/core";
import { describe, expect, it } from "vitest";
import { createFakeFetch, testDeps, type Route } from "../support/fake-fetch.js";

/** What a message capture's fake server serves for the contract: one inbox with one e-mail. */
export interface MessageCaptureFixture {
  /** Routes that create the inbox, list its one e-mail and delete it. */
  readonly routes: readonly Route[];
  readonly secrets: Readonly<Record<string, string>>;
  readonly expected: { readonly subject: string; readonly body: string };
}

/**
 * Contract of a {@link MessageCapture} (REQ-ENV-08, REQ-GEN-11/AC11): an inbox gets an address and a URL, its
 * messages are read back, it is deleted at cleanup, and a server error is an error, never "no message yet".
 *
 * @param name - The capture under test.
 * @param fixture - The fake server's content.
 * @param create - Builds the capture with the given adapter dependencies.
 */
export function messageCaptureContract(
  name: string,
  fixture: MessageCaptureFixture,
  create: (deps: AdapterDeps) => Promise<MessageCapture>,
): void {
  describe(`MessageCapture contract: ${name}`, () => {
    it("REQ-ENV-08/AC1+AC2+AC5: creates an inbox, reads its e-mail and deletes it", async () => {
      const fake = createFakeFetch(fixture.routes);
      const capture = await create(testDeps(fake.fetch, fixture.secrets));
      const inbox = await capture.createInbox("DEMO-1-run-TC-01");
      expect(inbox.email).toContain("@");
      expect(inbox.url).toMatch(/^https:\/\//);
      const messages = await capture.messages(inbox.id);
      expect(messages.find((m) => m.kind === "email")).toMatchObject({
        subject: fixture.expected.subject,
        body: fixture.expected.body,
      });
      await capture.deleteInbox(inbox.id);
      expect(fake.requests.at(-1)?.method).toBe("DELETE");
    });

    it("REQ-ENV-08/AC2: a server error while reading is an error, never an empty inbox", async () => {
      const fake = createFakeFetch([{ match: /.*/, reply: () => new Response("down", { status: 503 }) }]);
      const capture = await create(testDeps(fake.fetch, fixture.secrets));
      await expect(capture.messages("0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0")).rejects.toThrow();
    });
  });
}
