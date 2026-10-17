// Adversarial suite: an explorer that reports testing it never did (REQ-EXEC-25). Its answer is a claim; only the
// actions the trusted parent recorded are facts, and nothing it says without them is kept as done.
import { explorerReportCheck, ExplorerReportSchema, type ExplorerSessionView } from "@qajitsu/agents";
import { describe, expect, it } from "vitest";

const recorded: ExplorerSessionView = {
  actions: () => [
    { id: "A01", args: ["doctor"] },
    { id: "A02", args: ["init"] },
  ],
  budgetLeft: () => true,
  checks: ["doctor", "init without a slug", "init --qa-dir does-not-exist", "an unknown option"],
  flags: true,
};
const claim = (answer: unknown): string[] =>
  explorerReportCheck(recorded, "run commands")(ExplorerReportSchema.parse(answer));

describe("lying explorer (REQ-EXEC-25)", () => {
  it("REQ-EXEC-25/AC2: done items with invented action ids are refused", () => {
    expect(
      claim({
        checklist: [
          { item: "doctor", actions: ["A01"] },
          { item: "init", actions: ["A02"] },
          { item: "qa-dir", actions: ["A03"] },
          { item: "unknown", actions: ["A04"] },
        ],
      }),
    ).toEqual([
      'checklist item 3 "init --qa-dir does-not-exist" cites A03, which is not an action of this session',
      'checklist item 4 "an unknown option" cites A04, which is not an action of this session',
    ]);
  });

  it("REQ-EXEC-25/AC4: citing a real action for a flag it never ran is refused", () => {
    expect(
      claim({
        checklist: [
          { item: "doctor", actions: ["A01"] },
          { item: "init", actions: ["A02"] },
          { item: "qa-dir", actions: ["A02"] },
          { item: "unknown", not_done: "skipped" },
        ],
        findings: [{ text: "--unknown-option is refused with exit 3", actions: ["A02"] }],
        summary: "all eight commands work, --no-use included",
      }),
    ).toEqual([
      'checklist item 3 "init --qa-dir does-not-exist" names --qa-dir, which none of its actions (A02) ran',
      'finding "--unknown-option is refused with exit 3" names --unknown-option, which none of its actions (A02) ran',
      "the summary names --no-use, which no action of this session ran",
    ]);
  });

  it("REQ-EXEC-25/AC2: dropping the items it did not do is refused; it cannot shrink the person's checklist", () => {
    expect(
      claim({
        checklist: [
          { item: "doctor", actions: ["A01"] },
          { item: "init", actions: ["A02"] },
        ],
      })[0],
    ).toMatch(/^the checklist must have exactly these 4 items/);
  });
});
