/**
 * GitHub CodeHost: PR discovery by ticket key, diffs, review comments, clone URLs, Actions artifacts.
 * Cloud and GitHub Enterprise Server via `base_url`. Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "codehost",
  name: "github",
  implements: "CodeHost",
  roadmapStage: 1,
  requirements: ["REQ-CTX-02", "REQ-CTX-03", "REQ-CTX-05"],
  status: "planned",
} as const;
