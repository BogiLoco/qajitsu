/**
 * GitLab CodeHost: MR discovery by ticket key, diffs, review discussions, clone URLs, CI job artifacts.
 * GitLab.com and self-managed via `base_url`. Status: planned. Implement with `/new-adapter`.
 *
 * @packageDocumentation
 */
export const ADAPTER = {
  kind: "codehost",
  name: "gitlab",
  implements: "CodeHost",
  roadmapStage: 1,
  requirements: ["REQ-CTX-02", "REQ-CTX-03", "REQ-CTX-05"],
  status: "planned",
} as const;
