import { describe, expect, it } from "vitest";
import { explorerReportCheck, ExplorerReportSchema, type ExplorerSessionView } from "./explorer-report.js";

const view = (over: Partial<ExplorerSessionView> = {}): ExplorerSessionView => ({
  actions: () => [
    { id: "A01", args: ["doctor"] },
    { id: "A02", args: ["init"] },
    { id: "A03", args: ["init", "demo-shop", "--force"] },
  ],
  budgetLeft: () => true,
  checks: [],
  flags: true,
  ...over,
});
const report = (r: unknown) => ExplorerReportSchema.parse(r);
const done = (item: string, ...actions: string[]) => ({ item, actions });

describe("explorer report check (REQ-EXEC-25)", () => {
  it("REQ-EXEC-15/AC8: an answer before any action is rejected", () => {
    const check = explorerReportCheck(view({ actions: () => [] }), "run commands");
    expect(check(report({ checklist: [done("doctor", "A01")], findings: [], summary: "" }))).toEqual([
      "you did nothing yet: run commands first, then summarise only what the tools answered",
    ]);
  });

  it("REQ-EXEC-25/AC2: every done item and every finding cites actions of the session", () => {
    const check = explorerReportCheck(view(), "run commands");
    expect(
      check(
        report({
          checklist: [done("doctor", "A01"), done("init without a slug", "A02")],
          findings: [{ text: "init without a slug says what is missing", actions: ["A02"] }],
          summary: "doctor and init behave as documented",
        }),
      ),
    ).toEqual([]);
    const errors = explorerReportCheck(
      view(),
      "run commands",
    )(
      report({
        checklist: [done("doctor", "A07"), { item: "init", actions: [] }],
        findings: [{ text: "unknown options are refused", actions: ["A09"] }],
        summary: "",
      }),
    );
    expect(errors).toEqual([
      'checklist item 1 "doctor" cites A07, which is not an action of this session',
      'checklist item 2 "init" has neither actions nor not_done: do it, or say why it was not done',
      'finding "unknown options are refused" cites A09, which is not an action of this session',
    ]);
    expect(() => report({ checklist: [], findings: [], summary: "" })).toThrow();
    expect(() => report({ checklist: [done("x", "A01")], findings: [{ text: "x", actions: [] }] })).toThrow();
  });

  it("REQ-EXEC-25/AC1+AC2: the checklist of --check comes back complete and in order", () => {
    const checks = ["doctor", "init without a slug", "init --force"];
    const ok = explorerReportCheck(view({ checks }), "run commands");
    expect(
      ok(
        report({
          checklist: [done("doctor", "A01"), done("init with no slug", "A02"), done("init --force", "A03")],
          findings: [],
        }),
      ),
    ).toEqual([]);
    const dropped = explorerReportCheck(
      view({ checks }),
      "run commands",
    )(report({ checklist: [done("doctor", "A01"), done("init --force", "A03")], findings: [] }));
    expect(dropped).toEqual([
      'the checklist must have exactly these 3 items, in this order, each done with actions or not_done with the reason: 1. "doctor"; 2. "init without a slug"; 3. "init --force"',
    ]);
  });

  it("REQ-EXEC-25/AC3: items left undone while the budget lasts are rejected once, then accepted with the reason", () => {
    const answer = report({
      checklist: [done("doctor", "A01"), { item: "doctor --online", not_done: "no network in the sandbox" }],
      findings: [],
    });
    const check = explorerReportCheck(view(), "run commands");
    expect(check(answer)).toEqual([
      'you still have budget: do these items now, then answer again (keep not_done only for what cannot be done): "doctor --online"',
    ]);
    expect(check(answer)).toEqual([]);
    expect(explorerReportCheck(view({ budgetLeft: () => false }), "run commands")(answer)).toEqual([]);
  });

  it("REQ-EXEC-25/AC4: a flag named in an item, a finding or the comment must have been run", () => {
    const errors = explorerReportCheck(
      view({ checks: ["init --qa-dir does-not-exist"] }),
      "run commands",
    )(
      report({
        checklist: [done("init --qa-dir does-not-exist", "A02")],
        findings: [
          { text: "init --force exits 2", actions: ["A03"] },
          { text: "--no-use is ignored", actions: ["A02"] },
        ],
        summary: "tested --unknown-option and --force",
      }),
    );
    expect(errors).toEqual([
      'checklist item 1 "init --qa-dir does-not-exist" names --qa-dir, which none of its actions (A02) ran',
      'finding "--no-use is ignored" names --no-use, which none of its actions (A02) ran',
      "the summary names --unknown-option, which no action of this session ran",
    ]);
    // Browser sessions have no arguments: no flag check.
    expect(
      explorerReportCheck(
        view({ flags: false, actions: () => [{ id: "A01" }] }),
        "act",
      )(report({ checklist: [done("open --menu", "A01")], findings: [], summary: "--x" })),
    ).toEqual([]);
  });

  it("REQ-EXEC-25/AC7: an item naming a subcommand of the tool cites an action that ran that subcommand", () => {
    const session = view({
      tool: "qj",
      checks: ["qj doctor", "qj init bez nazwy", "qj init --qa-dir does-not-exist"],
      actions: () => [
        { id: "A01", args: ["init", "bez", "nazwy"] },
        { id: "A02", args: ["init", "--qa-dir", "does-not-exist"] },
      ],
    });
    // Session S05 of qwen3: doctor never ran, yet it cited A01 (init) for it.
    expect(
      explorerReportCheck(
        session,
        "run commands",
      )(
        report({
          checklist: [done("qj doctor", "A01"), done("init bez nazwy", "A01"), done("qa-dir", "A02")],
          findings: [{ text: "qj doctor exits 3", actions: ["A02"] }],
        }),
      ),
    ).toEqual([
      'checklist item 1 "qj doctor" names doctor, which none of its actions (A01) ran',
      'finding "qj doctor exits 3" names doctor, which none of its actions (A02) ran',
    ]);
  });

  it("REQ-EXEC-25/AC8: an item left not done although an action ran it is refused: a failing command is a result", () => {
    const session = view({
      tool: "qj",
      budgetLeft: () => false,
      checks: ["qj doctor", "qj init --qa-dir does-not-exist", "qj init --force"],
      actions: () => [
        { id: "A01", args: ["doctor"] },
        { id: "A02", args: ["init", "--qa-dir", "does-not-exist"] },
      ],
    });
    expect(
      explorerReportCheck(
        session,
        "run commands",
      )(
        report({
          checklist: [
            done("doctor", "A01"),
            { item: "qa-dir", not_done: "command failed with missing slug argument" },
            { item: "force", not_done: "no time" },
          ],
        }),
      ),
    ).toEqual([
      'checklist item 2 "qj init --qa-dir does-not-exist" is not_done, but A02 ran it: a command that ran is done whatever its exit code or error, which is what you report; cite A02',
    ]);
  });
});
