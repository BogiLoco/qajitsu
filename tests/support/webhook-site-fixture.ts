import type { MessageCaptureFixture } from "../contract/message-capture.contract.js";
import { jsonReply } from "./fake-fetch.js";

const UUID = "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0";

/** webhook.site with one inbox holding one e-mail, for the MessageCapture contract. */
export const webhookSiteFixture: MessageCaptureFixture = {
  routes: [
    { method: "POST", match: /^\/token$/, reply: jsonReply({ uuid: UUID }, 201) },
    {
      match: new RegExp(`^/token/${UUID}/requests\\?sorting=newest&per_page=50$`),
      reply: jsonReply({
        data: [
          {
            uuid: "r1",
            type: "email",
            created_at: "2026-10-07 10:00:05",
            content:
              "From: shop@example.com\r\nTo: x@email.webhook.site\r\nSubject: Confirm\r\n\r\nYour code is 482913",
          },
        ],
      }),
    },
    {
      method: "DELETE",
      match: new RegExp(`^/token/${UUID}$`),
      reply: () => new Response(null, { status: 204 }),
    },
  ],
  secrets: { "secret://env/WEBHOOKSITE_KEY": "ws-key-value" },
  expected: { subject: "Confirm", body: "Your code is 482913" },
};

/** The capture configuration matching {@link webhookSiteFixture}. */
export const webhookSiteConfig = {
  baseUrl: "https://webhook.site",
  emailDomain: "email.webhook.site",
  apiKey: "secret://env/WEBHOOKSITE_KEY",
};
