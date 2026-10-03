import { describe, expect, it } from "vitest";
import { TicketKeySchema } from "../identifiers.js";
import { renderTicketMarkdown } from "./ticket-snapshot.js";

describe("renderTicketMarkdown", () => {
  it("renders empty sections explicitly and lists development links", () => {
    const md = renderTicketMarkdown({
      key: TicketKeySchema.parse("DEMO-9"),
      summary: "S",
      description: " ",
      issueType: "Bug",
      status: "Open",
      labels: [],
      components: [],
      acceptanceCriteria: [],
      comments: [],
      linkedKeys: [],
      attachments: [],
      developmentLinks: [
        { url: "https://github.com/a/b/pull/1", kind: "pr", title: "DEMO-9 fix" },
        { url: "https://x/y", kind: "branch" },
      ],
    });
    expect(md).toContain("_(empty)_");
    expect(md).toContain("_(none found)_");
    expect(md).toContain("- pr: DEMO-9 fix https://github.com/a/b/pull/1");
    expect(md).toContain("- branch: https://x/y");
  });
});
