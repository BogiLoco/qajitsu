/**
 * GitLab CodeHost: gitlab.com and GitLab self-managed with project/group access tokens
 * (REQ-CTX-02, REQ-CTX-03).
 *
 * @packageDocumentation
 */
export { createGitLabCodeHost, toUnifiedDiff, GITLAB_MAX_PAGES, type GitLabConfig } from "./gitlab.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "codehost",
  name: "gitlab",
  implements: "CodeHost",
  roadmapStage: 1,
  requirements: ["REQ-CTX-02", "REQ-CTX-03"],
  status: "implemented",
} as const;
