import { describe, expect, it } from "vitest";
import { createFakeFetch, jsonReply, testDeps } from "../../../../tests/support/fake-fetch.js";
import { createWebhookSiteCapture } from "./webhook-site.js";

const UUID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

describe("webhook.site message capture (REQ-ENV-08)", () => {
  it("REQ-ENV-08/AC1+AC4: creates a token per inbox with the API key from a secret; e-mail address and URL follow from it", async () => {
    const fake = createFakeFetch([
      { method: "POST", match: /^\/token$/, reply: jsonReply({ uuid: UUID }, 201) },
    ]);
    const capture = createWebhookSiteCapture(
      {
        baseUrl: "https://webhook.site/",
        emailDomain: "email.webhook.site",
        apiKey: "secret://env/WEBHOOKSITE_KEY",
      },
      testDeps(fake.fetch, { "secret://env/WEBHOOKSITE_KEY": "ws-key-value" }),
    );
    expect(await capture.createInbox("DEMO-1-20261007-TC-01")).toEqual({
      id: UUID,
      email: `${UUID}@email.webhook.site`,
      url: `https://webhook.site/${UUID}`,
    });
    expect(fake.requests[0]?.headers["api-key"]).toBe("ws-key-value");
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toMatchObject({ alias: "DEMO-1-20261007-TC-01" });
  });

  it("REQ-ENV-08/AC2: reads e-mails (headers, raw body) and HTTP requests (SMS gateways, webhooks), newest first", async () => {
    const fake = createFakeFetch([
      {
        match: new RegExp(`^/token/${UUID}/requests\\?sorting=newest&per_page=50$`),
        reply: jsonReply({
          data: [
            {
              uuid: "r2",
              type: "email",
              created_at: "2026-10-07 10:00:05",
              content:
                "From: shop@example.com\r\nTo: x@email.webhook.site\r\nSubject: Confirm your\r\n account\r\n\r\nClick https://shop.example/a=\r\nctivate now",
            },
            {
              uuid: "r1",
              type: "web",
              created_at: "2026-10-07 10:00:01",
              content: '{"sms":"Your code is 482913"}',
              url: `https://webhook.site/${UUID}`,
            },
          ],
        }),
      },
      {
        method: "DELETE",
        match: new RegExp(`^/token/${UUID}$`),
        reply: () => new Response(null, { status: 204 }),
      },
    ]);
    const capture = createWebhookSiteCapture(
      { baseUrl: "https://webhook.site", emailDomain: "email.webhook.site" },
      testDeps(fake.fetch, {}),
    );
    expect(await capture.messages(UUID)).toEqual([
      {
        id: "r2",
        kind: "email",
        receivedAt: "2026-10-07T10:00:05.000Z",
        from: "shop@example.com",
        to: "x@email.webhook.site",
        subject: "Confirm your account",
        body: "Click https://shop.example/activate now",
      },
      {
        id: "r1",
        kind: "http",
        receivedAt: "2026-10-07T10:00:01.000Z",
        to: `https://webhook.site/${UUID}`,
        body: '{"sms":"Your code is 482913"}',
      },
    ]);
    await capture.deleteInbox(UUID);
    expect(fake.requests.at(-1)?.method).toBe("DELETE");
  });

  it("REQ-ENV-08/AC4: plain http to a remote host, invalid tokens and HTTP errors are refused", async () => {
    const deps = testDeps(createFakeFetch([{ match: /.*/, reply: jsonReply({}, 500) }]).fetch, {});
    expect(() =>
      createWebhookSiteCapture({ baseUrl: "http://webhook.site", emailDomain: "x" }, deps),
    ).toThrow(/https/);
    const capture = createWebhookSiteCapture(
      { baseUrl: "http://localhost:8084", emailDomain: "mail.local" },
      deps,
    );
    await expect(capture.messages("../../etc")).rejects.toMatchObject({ code: "WEBHOOKSITE_TOKEN_INVALID" });
    await expect(capture.messages(UUID)).rejects.toMatchObject({ code: "WEBHOOKSITE_HTTP_ERROR" });
  });
});
