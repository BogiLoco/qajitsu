import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AdfNodeSchema, adfToMarkdown, extractAcceptanceCriteria } from "./adf.js";

const fixture = (name: string): { fields: Record<string, unknown> } =>
  JSON.parse(readFileSync(new URL(`../../../../fixtures/jira/cloud/${name}`, import.meta.url), "utf8")) as {
    fields: Record<string, unknown>;
  };

describe("ADF conversion (REQ-CTX-01/AC1)", () => {
  const description = AdfNodeSchema.parse(fixture("issue-SHOP-482.json").fields["description"]);
  const markdown = adfToMarkdown(description);

  it("converts paragraphs, marks, headings, lists, code, cards, mentions, emoji, rules and tables", () => {
    expect(markdown).toContain("As a shopper I want the cart total to include my **discount code**.");
    expect(markdown).toContain("### Acceptance criteria");
    expect(markdown).toContain("- GET `/cart` returns the total rounded once to 2 decimals.");
    expect(markdown).toContain("See https://wiki.example.com/cart\n@Product Owner 😄");
    expect(markdown).toContain('```json\n{"code":"SAVE10"}\n```');
    expect(markdown).toContain("1. first");
    expect(markdown).toContain("---");
    expect(markdown).toContain("| Code | Percent |\n| --- | --- |\n| SAVE10 | 10 |");
  });

  it("extracts criteria under the heading and stops at the next heading", () => {
    expect(extractAcceptanceCriteria(markdown)).toEqual([
      "GET `/cart` returns the total rounded once to 2 decimals.",
      "Codes never stack.",
    ]);
  });

  it("handles strings, null, nested lists, blockquotes, em and unknown nodes", () => {
    expect(adfToMarkdown(null)).toBe("");
    expect(adfToMarkdown("plain")).toBe("plain");
    const doc = AdfNodeSchema.parse({
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [{ type: "paragraph", content: [{ type: "text", text: "q", marks: [{ type: "em" }] }] }],
        },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [{ type: "paragraph", content: [{ type: "text", text: "inner" }] }],
                    },
                  ],
                },
              ],
            },
          ],
        },
        { type: "panel", content: [{ type: "paragraph", content: [{ type: "text", text: "in panel" }] }] },
        { type: "status", attrs: { text: "x" } },
        { type: "heading", content: [{ type: "text", text: "h" }] },
      ],
    });
    expect(adfToMarkdown(doc)).toBe("> _q_\n\n- outer\n    - inner\n\nin panel\n\n### h");
  });

  it("whole-text mode takes list items or, without lists, every non-empty line", () => {
    expect(extractAcceptanceCriteria("1. a\n2) b\n- [x] c", true)).toEqual(["a", "b", "c"]);
    expect(extractAcceptanceCriteria("first rule\n\nsecond rule", true)).toEqual([
      "first rule",
      "second rule",
    ]);
    expect(extractAcceptanceCriteria("", true)).toEqual([]);
    expect(extractAcceptanceCriteria("**Acceptance criteria:**\n* one\n\n## Other\n* two")).toEqual(["one"]);
    expect(extractAcceptanceCriteria("no criteria here\n- item")).toEqual([]);
  });
});
