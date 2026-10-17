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
/** Subcommands a text names after the tool's name: "qj doctor" and "run `qj init`" name `doctor` and `init`. */
const subcommandsIn = (text: string, tool: string | undefined): string[] =>
  tool === undefined
    ? []
    : [
        ...new Set(
          [...text.matchAll(new RegExp(`(?<![\\w-])${escape(tool)}\\s+([^\\s-][^\\s,.;:)]*)`, "g"))].map(
            (m) => (m[1] ?? "").replace(/^[`'"]+|[`'"]+$/g, ""),
          ),
        ),
      ].filter((s) => s !== "");

/** Words of a checklist item, roughly stemmed, to tell a rephrased item from a swapped one. */
const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 3)
      .map((w) =>
        w.length > 5 && w.endsWith("ing")
          ? w.slice(0, -3)
          : w.length > 4 && w.endsWith("ed")
            ? w.slice(0, -2)
            : w.length > 3 && w.endsWith("s")
              ? w.slice(0, -1)
              : w,
      ),
  );
const likeness = (a: Set<string>, b: Set<string>): number => {
  const shared = [...a].filter((w) => b.has(w)).length;
  const all = new Set([...a, ...b]).size;
  return all === 0 ? 0 : shared / all;
};

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
    // REQ-EXEC-25/AC2: an item in another item's place of --check is a swap, not a rephrasing.
    if (view.checks.length > 1) {
      const checks = view.checks.map(words);
      report.checklist.forEach((entry, i) => {
        const said = words(entry.item);
        const scores = checks.map((c) => likeness(said, c));
        const best = scores.indexOf(Math.max(...scores));
        if (best !== i && (scores[best] ?? 0) > (scores[i] ?? 0))
          errors.push(
            `checklist item ${String(i + 1)} reads like item ${String(best + 1)} of --check ("${view.checks[best] ?? ""}"): keep the items in the order of --check`,
          );
      });
      if (errors.length > 0) return errors;
    }
    // A person's --check item is a command line; in the explorer's own prose only subcommands the session ran or the
    // person named count, so "qj prints help" is prose and "qj doctor" a claim about doctor.
    const known = new Set([
      ...[...args.values()].map((a) => a[0]).filter((a): a is string => a !== undefined),
      ...view.checks.flatMap((c) => subcommandsIn(c, view.tool)),
    ]);
    const named = (text: string, written: boolean): string[] =>
      subcommandsIn(text, view.tool).filter((c) => written || known.has(c));
    const cited = (what: string, ids: readonly string[], text: string, written = false): void => {
      const unknown = ids.filter((id) => !args.has(id));
      for (const id of unknown) errors.push(`${what} cites ${id}, which is not an action of this session`);
      if (!view.flags || unknown.length > 0) return;
      const used = ids.flatMap((id) => args.get(id) ?? []);
      // REQ-EXEC-25/AC7: "qj doctor" is done only by an action that ran doctor.
      for (const sub of named(text, written).filter((c) => !ids.some((id) => args.get(id)?.[0] === c)))
        errors.push(`${what} names ${sub}, which none of its actions (${ids.join(", ")}) ran`);
      for (const flag of flagsIn(text).filter((f) => !ran(f, used)))
        errors.push(`${what} names ${flag}, which none of its actions (${ids.join(", ")}) ran`);
    };
    /** Actions that ran everything an item names (its subcommand and flags), for items claimed not done. */
    const ranIt = (item: string, written: boolean): string[] => {
      const subs = named(item, written);
      const flags = flagsIn(item);
      if (!view.flags || (subs.length === 0 && flags.length === 0)) return [];
      return [...args.entries()]
        .filter(([, a]) => subs.every((c) => a[0] === c) && flags.every((f) => ran(f, a)))
        .map(([id]) => id);
    };
    report.checklist.forEach((entry, i) => {
      const item = view.checks[i] ?? entry.item;
      const what = `checklist item ${String(i + 1)} "${item}"`;
      const written = view.checks[i] !== undefined;
      if (entry.actions.length > 0) cited(what, entry.actions, item, written);
      else if (entry.not_done === undefined)
        errors.push(`${what} has neither actions nor not_done: do it, or say why it was not done`);
      else {
        // REQ-EXEC-25/AC8: a command that failed still ran; its error is the result, not a reason to skip it.
        const by = ranIt(item, written);
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

/**
 * The first command a command-line explorer should run, as a concrete tool call (REQ-EXEC-15/AC8): taken from the
 * first checklist item that names the tool ("qj status" → `["status"]`, flags included), else `--help`. Weak models
 * that answer before acting follow a concrete call better than a rule.
 *
 * @param checks - Items of `--check`.
 * @param tool - Name of the explored tool, e.g. `qj`.
 */
export function firstCommandHint(checks: readonly string[], tool: string): string {
  for (const check of checks) {
    const m = new RegExp(`(?<![\\w-])${escape(tool)}((?:\\s+[^\\s\`'"]+)+)`).exec(check);
    const args = (m?.[1] ?? "").trim().split(/\s+/).filter(Boolean);
    if (args.length > 0) return `cli_run with {"args": [${args.map((a) => JSON.stringify(a)).join(", ")}]}`;
  }
  return 'cli_run with {"args": ["--help"]}';
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
