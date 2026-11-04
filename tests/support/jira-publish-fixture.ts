import { jsonReply, type Route } from "./fake-fetch.js";

/** Jira as the publisher contract and the Jira publisher tests see it: comments and attachments on SHOP-482. */
export const jiraPublishSecrets = {
  "secret://env/JIRA_EMAIL": "qa@example.com",
  "secret://env/JIRA_TOKEN": "jira-token-123456",
};

/** The fake Jira server for publishing; `extra` routes come first. */
export const jiraPublishRoutes = (extra: Route[] = []): Route[] => [
  ...extra,
  {
    method: "POST",
    match: /^\/rest\/api\/[23]\/issue\/SHOP-482\/comment$/,
    reply: jsonReply({ id: "10001" }, 201),
  },
  {
    method: "PUT",
    match: /^\/rest\/api\/[23]\/issue\/SHOP-482\/comment\/10001$/,
    reply: jsonReply({ id: "10001" }),
  },
  {
    method: "POST",
    match: /^\/rest\/api\/[23]\/issue\/SHOP-482\/attachments$/,
    reply: (r) => jsonReply((r.files ?? []).map((f, i) => ({ id: 500 + i, filename: f })))(r),
  },
];
