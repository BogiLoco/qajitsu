import { fixture, jsonReply, type Route } from "./fake-fetch.js";

/** Jira Cloud as the ticket source contract and the Jira adapter tests see it: SHOP-482 and its development panel. */
export const jiraSecrets = {
  "secret://env/JIRA_EMAIL": "qa@example.com",
  "secret://env/JIRA_TOKEN": "jira-api-token-123",
};

/** The source configuration matching {@link jiraRoutes}. */
export const jiraConfig = {
  baseUrl: "https://jira.example.com",
  email: "secret://env/JIRA_EMAIL",
  token: "secret://env/JIRA_TOKEN",
};

/** The fake Jira Cloud server; `overrides` come first. */
export const jiraRoutes = (overrides: Route[] = []): Route[] => [
  ...overrides,
  {
    match: /^\/rest\/api\/3\/issue\/SHOP-482\?/,
    reply: jsonReply(fixture("jira/cloud/issue-SHOP-482.json")),
  },
  {
    match: /^\/rest\/api\/3\/issue\/SHOP-483\?/,
    reply: jsonReply(fixture("jira/cloud/issue-SHOP-483-custom-ac.json")),
  },
  {
    match: /dev-status.*applicationType=GitHub&dataType=pullrequest/,
    reply: jsonReply(fixture("jira/cloud/dev-status-github-pullrequest.json")),
  },
  {
    match: /dev-status.*applicationType=GitLab&dataType=pullrequest/,
    reply: jsonReply(fixture("jira/cloud/dev-status-gitlab-pullrequest.json")),
  },
  {
    match: /dev-status.*dataType=branch/,
    reply: jsonReply(fixture("jira/cloud/dev-status-github-pullrequest.json")),
  },
];
