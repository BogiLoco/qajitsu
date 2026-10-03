import { z } from "zod";

/** A node of Atlassian Document Format; only the fields used for conversion are typed. */
export interface AdfNode {
  readonly type: string;
  readonly text?: string | undefined;
  readonly attrs?: Readonly<Record<string, unknown>> | undefined;
  readonly marks?: readonly { readonly type: string }[] | undefined;
  readonly content?: readonly AdfNode[] | undefined;
}

/** Zod schema of an ADF node (recursive, unknown attributes allowed). */
export const AdfNodeSchema: z.ZodType<AdfNode> = z.lazy(() =>
  z.object({
    type: z.string(),
    text: z.string().optional(),
    attrs: z.record(z.string(), z.unknown()).optional(),
    marks: z.array(z.object({ type: z.string() })).optional(),
    content: z.array(AdfNodeSchema).optional(),
  }),
);

const attr = (node: AdfNode, name: string): string => {
  const value = node.attrs?.[name];
  return typeof value === "string" ? value : "";
};

const inline = (nodes: readonly AdfNode[] = []): string =>
  nodes
    .map((node) => {
      switch (node.type) {
        case "text": {
          const text = node.text ?? "";
          const marks = new Set((node.marks ?? []).map((m) => m.type));
          if (marks.has("code")) return `\`${text}\``;
          if (marks.has("strong")) return `**${text}**`;
          if (marks.has("em")) return `_${text}_`;
          return text;
        }
        case "hardBreak":
          return "\n";
        case "mention":
          return attr(node, "text");
        case "emoji":
          return attr(node, "text") || attr(node, "shortName");
        case "inlineCard":
          return attr(node, "url");
        default:
          return inline(node.content);
      }
    })
    .join("");

const block = (node: AdfNode, indent: string): string => {
  switch (node.type) {
    case "paragraph":
      return inline(node.content);
    case "heading":
      return `${"#".repeat(Number(node.attrs?.["level"] ?? 3))} ${inline(node.content)}`;
    case "bulletList":
    case "orderedList":
      return (node.content ?? [])
        .map((item, i) => {
          const bullet = node.type === "bulletList" ? "-" : `${String(i + 1)}.`;
          const body = (item.content ?? []).map((child) => block(child, `${indent}  `)).join(`\n${indent}  `);
          return `${indent}${bullet} ${body}`;
        })
        .join("\n");
    case "codeBlock":
      return `\`\`\`${attr(node, "language")}\n${inline(node.content)}\n\`\`\``;
    case "blockquote":
      return blocks(node.content, indent)
        .split("\n")
        .map((l) => `> ${l}`)
        .join("\n");
    case "rule":
      return "---";
    case "table": {
      const rows = (node.content ?? []).map(
        (row) =>
          `| ${(row.content ?? []).map((cell) => blocks(cell.content, "").replaceAll("\n", " ")).join(" | ")} |`,
      );
      const width = node.content?.[0]?.content?.length ?? 0;
      if (rows.length > 0) rows.splice(1, 0, `|${" --- |".repeat(width)}`);
      return rows.join("\n");
    }
    default:
      return node.content ? blocks(node.content, indent) : inline([node]);
  }
};

const blocks = (nodes: readonly AdfNode[] = [], indent = ""): string =>
  nodes
    .map((n) => block(n, indent))
    .filter((s) => s !== "")
    .join("\n\n");

/**
 * Converts an ADF document (or a plain string, as returned by some custom fields) to Markdown.
 *
 * @param doc - ADF document, string or null.
 * @returns Markdown text; empty for null.
 */
export function adfToMarkdown(doc: AdfNode | string | null | undefined): string {
  if (doc === null || doc === undefined) return "";
  if (typeof doc === "string") return doc;
  return blocks(doc.content);
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.*\S)\s*$/;
const AC_HEADING =
  /^(?:#{1,6}\s*|\*\*)?\s*(?:acceptance criteria|kryteria akceptacji|ac)\s*:?\s*(?:\*\*)?\s*$/i;

/**
 * Extracts acceptance criteria from Markdown: the list items under an "Acceptance criteria" heading
 * (until the next heading), or every top-level list item when `wholeText` is set (custom field).
 *
 * @param markdown - Description or custom field converted to Markdown.
 * @param wholeText - Treat the whole text as the criteria section.
 */
export function extractAcceptanceCriteria(markdown: string, wholeText = false): string[] {
  const lines = markdown.split("\n");
  let inSection = wholeText;
  const criteria: string[] = [];
  for (const line of lines) {
    if (AC_HEADING.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && !wholeText && /^#{1,6}\s/.test(line)) break;
    if (!inSection || /^\s{2,}/.test(line)) continue;
    const match = LIST_ITEM.exec(line);
    if (match?.[1]) criteria.push(match[1]);
  }
  if (wholeText && criteria.length === 0 && markdown.trim() !== "") {
    return markdown
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "");
  }
  return criteria;
}

/**
 * Converts the Jira wiki markup of Data Center descriptions and comments to Markdown: headings,
 * bullet and numbered lists, bold, monospace and code blocks (REQ-PUB-03).
 *
 * @param wiki - Wiki markup.
 */
export function wikiToMarkdown(wiki: string): string {
  return wiki
    .replace(/\{code(?::[^}]*)?\}([\s\S]*?)\{code\}/g, (_, code: string) => `\`\`\`\n${code.trim()}\n\`\`\``)
    .split(/\r?\n/)
    .map((line) => {
      const h = /^h([1-6])\.\s+(.*)$/.exec(line);
      if (h?.[1] && h[2] !== undefined) return `${"#".repeat(Number(h[1]))} ${h[2]}`;
      const bullet = /^(\*+)\s+(.*)$/.exec(line);
      if (bullet?.[1] && bullet[2] !== undefined) return `${"  ".repeat(bullet[1].length - 1)}- ${bullet[2]}`;
      const num = /^(#+)\s+(.*)$/.exec(line);
      if (num?.[1] && num[2] !== undefined) return `${"  ".repeat(num[1].length - 1)}1. ${num[2]}`;
      return line;
    })
    .join("\n")
    .replace(/\{\{([^}]+)\}\}/g, "`$1`")
    .replace(/(^|\s)\*([^*\n]+)\*(?=\s|$|[.,;:])/g, "$1**$2**");
}
