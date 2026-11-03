import type { CodeHostScenario } from "../contract/code-host.contract.js";
import { fixture, jsonReply, textReply, type Route } from "./fake-fetch.js";

/** GitHub as the code host contract and the GitHub adapter tests see it: example-org/shop-web with PR 12. */
export const H1 = "1".repeat(40);
export const H2 = "2".repeat(40);
export const GITHUB_TOKEN = "github-token-value";

export const githubRoutes: Route[] = [
  {
    match: /^\/repos\/example-org\/shop-web\/pulls\?state=all/,
    reply: jsonReply(fixture("github/pulls-list.json")),
  },
  { match: /^\/repos\/example-org\/shop-web\/branches\?/, reply: jsonReply(fixture("github/branches.json")) },
  {
    match: /^\/repos\/example-org\/shop-web\/pulls\/12\/comments/,
    reply: jsonReply(fixture("github/pull-12-review-comments.json")),
  },
  {
    match: /^\/repos\/example-org\/shop-web\/issues\/12\/comments/,
    reply: jsonReply(fixture("github/issue-12-comments.json")),
  },
  {
    match: /^\/repos\/example-org\/shop-web\/pulls\/12$/,
    reply: (req) =>
      req.headers["accept"] === "application/vnd.github.diff"
        ? new Response(fixture("github/pull-12.diff"))
        : new Response(fixture("github/pull-12.json")),
  },
  {
    match: /^\/repos\/example-org\/shop-web\/commits\//,
    reply: jsonReply(fixture("github/commit-spike.json")),
  },
  { match: /^\/repos\/example-org\/shop-web$/, reply: jsonReply({ default_branch: "main" }) },
  {
    match: /^\/repos\/example-org\/shop-web\/compare\/main\.\.\.2{40}$/,
    reply: textReply(fixture("github/pull-12.diff")),
  },
];

/** What {@link githubRoutes} serve, for the CodeHost contract. */
export const githubScenario: CodeHostScenario = {
  repo: "example-org/shop-web",
  changeUrl: "https://github.com/example-org/shop-web/pull/12",
  change: { kind: "pr", id: "12", headSha: H1 },
  branchOnly: { id: "spike/SHOP-482-ui", headSha: H2 },
  token: GITHUB_TOKEN,
  cloneUrl: "https://github.com/example-org/shop-web.git",
};
