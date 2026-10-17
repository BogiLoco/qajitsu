import { z } from "zod";

const ActionId = z.string().regex(/^A\d{2,3}$/);

/**
 * The final answer of every explorer (REQ-EXEC-25): the checklist of the goal, item by item, findings, and a short
 * comment. Each done item and each finding cites the actions that show it; code checks them before they are kept.
 */
export const ExplorerReportSchema = z.strictObject({
  checklist: z
    .array(
      z.strictObject({
        item: z.string().min(1).max(300),
        actions: z.array(ActionId).max(40).default([]),
        not_done: z.string().min(1).max(500).optional(),
      }),
    )
    .min(1)
    .max(30),
  findings: z
    .array(z.strictObject({ text: z.string().min(1).max(600), actions: z.array(ActionId).min(1).max(40) }))
    .max(30)
    .default([]),
  summary: z.string().max(2000).default(""),
});

/** The explorer's validated answer. */
export type ExplorerReport = z.infer<typeof ExplorerReportSchema>;

/** What code knows about a running session, to check an explorer's answer against it. */
export interface ExplorerSessionView {
  /** Actions the trusted parent recorded so far, with the arguments of command-line actions. */
  readonly actions: () => readonly { readonly id: string; readonly args?: readonly string[] }[];
  /** True while the step budget is not used up. */
  readonly budgetLeft: () => boolean;
  /** The checklist the person gave with `--check`, in order; empty when the explorer writes its own. */
  readonly checks: readonly string[];
  /** Check that flags named in the answer were run (command-line sessions). */
  readonly flags: boolean;
  /** Name of the explored tool (`qj`): "qj doctor" in an item names the subcommand `doctor`. */
  readonly tool?: string | undefined;
}

const FLAG = /(?<![\w-])--[a-z][a-z0-9-]*/gi;
const flagsIn = (text: string): string[] => [...new Set(text.match(FLAG) ?? [])];
const ran = (flag: string, args: readonly string[]): boolean =>
  args.some((a) => a === flag || a.startsWith(`${flag}=`));
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Subcommands a text names after the tool's name: "qj doctor" and "run qj init" name `doctor` and `init`. */
const subcommandsIn = (text: string, tool: string | undefined): string[] =>
  tool === undefined
    ? []
    : [
        ...new Set(
          [...text.matchAll(new RegExp(`(?<![\\w-])${escape(tool)}\\s+([^\\s-][^\\s,.;:)]*)`, "g"))].map(
            (m) => m[1] ?? "",
          ),
        ),
      ].filter((s) => s !== "");

/**
 * Builds the code check of an explorer's answer (REQ-EXEC-15/AC8, REQ-EXEC-25/AC1-AC4): no answer before any action,
 * the `--check` checklist complete and in order, every done item and finding citing real actions, items left undone
 * while the budget lasts sent back once, and in command-line sessions no flag the session never ran. The model's text
 * is a claim; only the recorded actions are facts.
 *
 * @param view - What the session recorded so far.
 * @param howToAct - What the agent should do when it has done nothing yet, named for its tools.
 * @returns A validator for the agent loop; it keeps state, so build one per session.
 */
export function explorerReportCheck(
  view: ExplorerSessionView,
  howToAct: string,
): (report: ExplorerReport) => string[] {
  let undoneSentBack = false;
  return (report) => {
    const actions = view.actions();
    if (actions.length === 0)
      return [`you did nothing yet: ${howToAct} first, then summarise only what the tools answered`];
    if (view.checks.length > 0 && report.checklist.length !== view.checks.length)
      return [
        `the checklist must have exactly these ${String(view.checks.length)} items, in this order, each done with actions or not_done with the reason: ${view.checks.map((c, i) => `${String(i + 1)}. "${c}"`).join("; ")}`,
      ];
    const args = new Map(actions.map((a) => [a.id, a.args ?? []]));
    const errors: string[] = [];
    const cited = (what: string, ids: readonly string[], text: string): void => {
      const unknown = ids.filter((id) => !args.has(id));
      for (const id of unknown) errors.push(`${what} cites ${id}, which is not an action of this session`);
      if (!view.flags || unknown.length > 0) return;
      const used = ids.flatMap((id) => args.get(id) ?? []);
      // REQ-EXEC-25/AC7: "qj doctor" is done only by an action that ran doctor.
      for (const sub of subcommandsIn(text, view.tool).filter(
        (c) => !ids.some((id) => args.get(id)?.[0] === c),
      ))
        errors.push(`${what} names ${sub}, which none of its actions (${ids.join(", ")}) ran`);
      for (const flag of flagsIn(text).filter((f) => !ran(f, used)))
        errors.push(`${what} names ${flag}, which none of its actions (${ids.join(", ")}) ran`);
    };
    /** Actions that ran everything an item names (its subcommand and flags), for items claimed not done. */
    const ranIt = (item: string): string[] => {
      const subs = subcommandsIn(item, view.tool);
      const flags = flagsIn(item);
      if (!view.flags || (subs.length === 0 && flags.length === 0)) return [];
      return [...args.entries()]
        .filter(([, a]) => subs.every((c) => a[0] === c) && flags.every((f) => ran(f, a)))
        .map(([id]) => id);
    };
    report.checklist.forEach((entry, i) => {
      const item = view.checks[i] ?? entry.item;
      const what = `checklist item ${String(i + 1)} "${item}"`;
      if (entry.actions.length > 0) cited(what, entry.actions, item);
      else if (entry.not_done === undefined)
        errors.push(`${what} has neither actions nor not_done: do it, or say why it was not done`);
      else {
        // REQ-EXEC-25/AC8: a command that failed still ran; its error is the result, not a reason to skip it.
        const by = ranIt(item);
        if (by.length > 0)
          errors.push(
            `${what} is not_done, but ${by.join(", ")} ran it: a command that ran is done whatever its exit code or error, which is what you report; cite ${by.join(", ")}`,
          );
      }
    });
    for (const f of report.findings) cited(`finding "${f.text}"`, f.actions, f.text);
    if (view.flags) {
      const all = [...args.values()].flat();
      for (const flag of flagsIn(report.summary).filter((f) => !ran(f, all)))
        errors.push(`the summary names ${flag}, which no action of this session ran`);
    }
    if (errors.length > 0) return errors;
    const undone = report.checklist
      .map((entry, i) => ({ item: view.checks[i] ?? entry.item, done: entry.actions.length > 0 }))
      .filter((e) => !e.done);
    if (undone.length > 0 && view.budgetLeft() && !undoneSentBack) {
      undoneSentBack = true;
      return [
        `you still have budget: do these items now, then answer again (keep not_done only for what cannot be done): ${undone.map((e) => `"${e.item}"`).join(", ")}`,
      ];
    }
    return [];
  };
}

/** How every explorer answers; shared by the browser and command-line prompts (REQ-EXEC-25/AC2). */
export const EXPLORER_REPORT_RULES = `When you are done, answer with one JSON object only:
{"checklist": [{"item": "one thing the goal asks", "actions": ["A01", "A02"]},
               {"item": "another one", "not_done": "why it could not be done"}],
 "findings": [{"text": "one thing you saw, as it was", "actions": ["A02"]}],
 "summary": "a short comment"}
Every done item and every finding cites the actions that show it; anything you did not do is not_done with the
reason. Code checks every action id against what was recorded and rejects claims of testing that did not happen.`;

/**
 * The checklist part of an explorer's prompt: the person's items, or the instruction to write one from the goal.
 *
 * @param checks - Items of `--check`, in order.
 */
export const checklistPrompt = (checks: readonly string[]): string =>
  checks.length > 0
    ? `## Checklist (from the person; report every item, in this order)\n${checks.map((c, i) => `${String(i + 1)}. ${c}`).join("\n")}`
    : "## Checklist\nBefore you start, split the goal into the separate things it asks for; do each one and report each one in the checklist of your answer.";
