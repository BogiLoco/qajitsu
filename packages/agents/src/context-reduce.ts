import type { ContextFragment } from "@qajitsu/core";

/** Words that say nothing about what a fragment is about. */
const STOP = new Set(
  "that this with from have will when then than there their they them these those into about which would should could must shall your what where while after before each every other some such only also more most very just like make made does done case cases step steps test tests plan expect expected value values data true false null none json".split(
    " ",
  ),
);

/**
 * Terms that say what a task is about (REQ-CTX-12/AC6): paths, identifiers and longer words of the anchors (the
 * ticket and its criteria, the plan's steps, the question), lower case, at most 200, in a fixed order.
 *
 * @param anchors - Texts of the fragments that define the task.
 */
export function anchorTerms(anchors: readonly string[]): string[] {
  const terms = new Set<string>();
  for (const text of anchors)
    for (const m of text.toLowerCase().matchAll(/[a-z_][\w./:-]{3,}/g)) {
      const t = m[0].replace(/[.:-]+$/, "");
      if (t.length >= 4 && !STOP.has(t)) terms.add(t);
    }
  return [...terms].sort().slice(0, 200);
}

/**
 * How relevant a fragment is to the task: the anchor terms its source or text contains, with up to eight of them as
 * the reason (REQ-CTX-12/AC6). Computed by code; a similarity from the embedding model may be added by the caller.
 *
 * @param f - The fragment.
 * @param terms - The task's anchor terms.
 */
export function relevance(f: ContextFragment, terms: readonly string[]): { score: number; terms: string[] } {
  const hay = `${f.source}\n${f.text}`.toLowerCase();
  const hit = terms.filter((t) => hay.includes(t));
  return { score: hit.length, terms: hit.slice(0, 8) };
}

/** Lines of a log or result that matter: errors and failures with a few lines around them. */
const SIGNAL =
  /\b(error|fail(ed|ure)?|exception|denied|refused|timeout|timed out|warn(ing)?|panic|fatal|traceback|status[^\n]{0,8}[45]\d\d)\b|[✘×]/i;

/**
 * A shorter text that keeps the structure (REQ-CTX-14/AC2): a diff keeps its file headers, hunk headers (with the
 * enclosing signature) and changed lines; logs, results and evidence keep error lines with two lines around them, or
 * their head and tail. Undefined when trimming would not save enough to be worth it.
 *
 * @param f - The fragment.
 * @param handle - The handle of the full text, named in the note.
 */
export function trimmed(f: ContextFragment, handle: string): string | undefined {
  const lines = f.text.split("\n");
  if (lines.length < 40) return undefined;
  let kept: string[];
  if (f.kind === "diff") {
    kept = lines.filter(
      (l) =>
        l.startsWith("diff --git") ||
        l.startsWith("@@") ||
        l.startsWith("+++") ||
        l.startsWith("---") ||
        ((l.startsWith("+") || l.startsWith("-")) && !l.startsWith("++") && !l.startsWith("--")),
    );
  } else if (["log", "result", "evidence", "tool-result", "spec"].includes(f.kind)) {
    const keep = new Set<number>();
    lines.forEach((l, i) => {
      if (SIGNAL.test(l))
        for (let j = Math.max(0, i - 2); j <= Math.min(lines.length - 1, i + 2); j += 1) keep.add(j);
    });
    kept =
      keep.size > 0
        ? lines.filter((_, i) => keep.has(i))
        : [...lines.slice(0, 20), `… ${String(lines.length - 40)} lines …`, ...lines.slice(-20)];
  } else return undefined;
  const text = `${kept.join("\n")}\n[trimmed by QAJitsu: ${String(lines.length - kept.length)} of ${String(lines.length)} lines left out; the full text is ${handle}, read it with read_context]`;
  return text.length < f.text.length * 0.6 ? text : undefined;
}

/** The handle of a fragment: stable for the same text. */
export const handleOf = (f: Pick<ContextFragment, "sha256">): string => `h-${f.sha256.slice(0, 8)}`;
