/** The tag of a component in the knowledge base (`component-payments-api`), for resolved bugs (REQ-KNOW-12/AC2). */
export const componentTag = (name: string): string =>
  `component-${
    name
      .toLowerCase()
      .replace(/[^a-z0-9.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 30) || "none"
  }`;

/**
 * Markdown of a resolved bug for the knowledge base: what broke, where, how it was resolved, the last comments
 * (REQ-KNOW-12/AC2).
 *
 * @param key - The issue key.
 * @param summary - Its summary.
 * @param details - Components, resolution, fix versions, description and the last comments.
 */
export function bugMarkdown(
  key: string,
  summary: string,
  details: {
    components: readonly string[];
    resolution?: string | undefined;
    resolvedAt?: string | undefined;
    fixVersions: readonly string[];
    description: string;
    comments: readonly string[];
  },
): string {
  return [
    `# ${key} ${summary}`,
    "",
    `Components: ${details.components.join(", ") || "none"}`,
    `Resolution: ${details.resolution ?? "unknown"}${details.resolvedAt ? ` (${details.resolvedAt.slice(0, 10)})` : ""}`,
    ...(details.fixVersions.length > 0 ? [`Fix versions: ${details.fixVersions.join(", ")}`] : []),
    "",
    "## Description",
    details.description || "(none)",
    ...(details.comments.length > 0 ? ["", "## Comments", ...details.comments.map((c) => `- ${c}`)] : []),
  ].join("\n");
}
