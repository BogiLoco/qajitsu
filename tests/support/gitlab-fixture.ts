import type { CodeHostScenario } from "../contract/code-host.contract.js";
import { fixture, jsonReply, type Route } from "./fake-fetch.js";

/** GitLab as the code host contract and the GitLab adapter tests see it: shop/platform/backend with MR 7. */
export const H1 = "1".repeat(40);
export const H2 = "2".repeat(40);
export const GITLAB_TOKEN = "gitlab-token-value";
const P = "\\/api\\/v4\\/projects\\/shop%2Fplatform%2Fbackend";
/** A path of the project in the GitLab API, as a pattern. */
export const r = (suffix: string): RegExp => new RegExp(`^${P}${suffix}`);

export const SHA = "b".repeat(40);
export const gitlabRoutes: Route[] = [
  { match: r(`\\/pipelines\\?sha=${SHA}&status=success`), reply: jsonReply([{ id: 31 }, { id: 32 }]) },
  {
    match: r("\\/pipelines\\/31\\/jobs"),
    reply: jsonReply([{ id: 1, name: "android", artifacts_file: null }]),
  },
  {
    match: r("\\/pipelines\\/32\\/jobs"),
    reply: jsonReply([{ id: 2, name: "android", artifacts_file: { filename: "artifacts.zip" } }]),
  },
  { match: r("\\/jobs\\/2\\/artifacts$"), reply: () => new Response(new Uint8Array([80, 75])) },
  { match: r("\\/merge_requests\\?state=all"), reply: jsonReply(fixture("gitlab/merge-requests-list.json")) },
  {
    match: r("\\/merge_requests\\/7\\/diffs"),
    reply: jsonReply(fixture("gitlab/merge-request-7-diffs.json")),
  },
  {
    match: r("\\/merge_requests\\/7\\/notes"),
    reply: jsonReply(fixture("gitlab/merge-request-7-notes.json")),
  },
  { match: r("\\/merge_requests\\/7$"), reply: jsonReply(fixture("gitlab/merge-request-7.json")) },
  {
    match: r("\\/repository\\/branches\\?search=SHOP-482"),
    reply: jsonReply(fixture("gitlab/branches-search.json")),
  },
  { match: r("\\/repository\\/commits\\/"), reply: jsonReply(fixture("gitlab/commit-spike.json")) },
  { match: r("\\/repository\\/compare\\?"), reply: jsonReply(fixture("gitlab/compare.json")) },
  { match: r("$"), reply: jsonReply(fixture("gitlab/project.json")) },
];

/** What {@link gitlabRoutes} serve, for the CodeHost contract. */
export const gitlabScenario: CodeHostScenario = {
  repo: "shop/platform/backend",
  changeUrl: "https://gitlab.example.com/shop/platform/backend/-/merge_requests/7/diffs",
  change: { kind: "mr", id: "7", headSha: H1 },
  branchOnly: { id: "spike/SHOP-482-ui", headSha: H2 },
  token: GITLAB_TOKEN,
  cloneUrl: "https://gitlab.example.com/shop/platform/backend.git",
};
