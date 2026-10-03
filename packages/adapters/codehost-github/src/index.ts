/**
 * GitHub CodeHost: github.com and GitHub Enterprise Server, fine-grained token or GitHub App
 * (REQ-CTX-02, REQ-CTX-03).
 *
 * @packageDocumentation
 */
export { createGitHubCodeHost, GITHUB_MAX_PAGES, type GitHubConfig } from "./github.js";
export { createAppJwt } from "./github-app.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "codehost",
  name: "github",
  implements: "CodeHost",
  roadmapStage: 1,
  requirements: ["REQ-CTX-02", "REQ-CTX-03"],
  status: "implemented",
} as const;
