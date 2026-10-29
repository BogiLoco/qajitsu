import { createHash } from "node:crypto";
import { AnalysisSchema, type Analysis } from "@qajitsu/core";
import { DIFF_INLINE_LIMIT, type ChangeContext } from "./context.js";

/** One part of a change too large for one analyst call (REQ-CTX-19/AC1). */
export interface ChangePart {
  /** `P1`, `P2`, ... in the order of the split. */
  readonly id: string;
  readonly repo: string;
  /** Changed files of the part, sorted. */
  readonly files: readonly string[];
  /** Estimated tokens of the part's diff (four characters per token). */
  readonly tokens: number;
  /** SHA-256 of the part's diff: the same change gives the same parts (AC4). */
  readonly sha256: string;
}

/** The split of a change: its parts, and a change context per part that holds only that part's code. */
export interface ChangeSplit {
  readonly parts: readonly { readonly part: ChangePart; readonly context: ChangeContext }[];
}

/** Code-point order, the same on every machine and locale (AC4). */
const byCode = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const tokensOf = (text: string): number => Math.ceil(text.length / 4);

/**
 * The group a changed file belongs to: its module directory without source and test roots, so `src/cart/total.ts` and
 * `tests/cart/total.test.ts` (or `src/cart/__tests__/total.spec.ts`) land in the same group `cart`.
 */
export function moduleOf(path: string): string {
  const dirs = path.split("/").slice(0, -1);
  const kept = dirs.filter((d) => !/^(src|lib|app|tests?|spec|__tests__|e2e)$/.test(d));
  return kept.join("/") || ".";
}

/** The diff of every file of a repository, by path. */
function fileDiffs(diff: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const chunk of diff.split(/^(?=diff --git )/m).filter((c) => c.startsWith("diff --git "))) {
    const path = /^diff --git a\/.+? b\/(.+)$/m.exec(chunk)?.[1] ?? "";
    out.set(path, (out.get(path) ?? "") + chunk);
  }
  return out;
}

/**
 * Whether a change's code fits the analyst in one call (REQ-CTX-19/AC1): every repository's diff is inlined and all
 * diffs together stay under the share of the budget the change may take.
 *
 * @param context - The change context.
 * @param diffBudget - Tokens the change's diffs may take in one call.
 */
export function changeFits(context: ChangeContext, diffBudget: number): boolean {
  if (context.codeAccess && context.codeAccess.level !== "full") return true;
  const total = context.repos.reduce((sum, r) => sum + tokensOf(r.diff), 0);
  return context.repos.every((r) => r.diffInlined || r.diff.length === 0) && total <= diffBudget;
}

/**
 * Splits a change into parts that fit one call each (REQ-CTX-19/AC1, AC4): per repository, then per group of related
 * files (a module with its handlers and tests, see {@link moduleOf}); groups are packed in a fixed order up to the
 * budget, a group over the budget is split per file. The split is a pure function of the change and the budget.
 *
 * @param context - The change context.
 * @param diffBudget - Tokens one part's diff may take.
 */
export function splitChange(
  context: ChangeContext,
  diffBudget: number,
  /** Groups joined by meaning (REQ-CTX-20/AC4): `<repo>:<group>` to the `<repo>:<group>` it joins. */
  join: ReadonlyMap<string, string> = new Map(),
): ChangeSplit {
  const parts: { part: ChangePart; context: ChangeContext }[] = [];
  const limit = Math.max(1, diffBudget);
  for (const repo of [...context.repos].sort((a, b) => byCode(a.alias, b.alias))) {
    const diffs = fileDiffs(repo.diff);
    const groups = new Map<string, string[]>();
    for (const path of [...diffs.keys()].sort()) {
      const own = `${repo.alias}:${moduleOf(path)}`;
      const key = (join.get(own) ?? own).slice(repo.alias.length + 1);
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    // Groups too large for one part are split per file; then consecutive pieces are packed up to the budget.
    const pieces: string[][] = [];
    for (const key of [...groups.keys()].sort()) {
      const files = groups.get(key) ?? [];
      const size = files.reduce((s, f) => s + tokensOf(diffs.get(f) ?? ""), 0);
      if (size <= limit) pieces.push(files);
      else for (const f of files) pieces.push([f]);
    }
    let current: string[] = [];
    let size = 0;
    const flush = (): void => {
      if (current.length === 0) return;
      const diff = current.map((f) => diffs.get(f) ?? "").join("");
      const id = `P${String(parts.length + 1)}`;
      const files = new Set(current);
      parts.push({
        part: {
          id,
          repo: repo.alias,
          files: [...current],
          tokens: tokensOf(diff),
          sha256: createHash("sha256").update(diff).digest("hex"),
        },
        context: {
          ...context,
          repos: [
            {
              ...repo,
              files: repo.files.filter((f) => files.has(f.path)).sort((a, b) => byCode(a.path, b.path)),
              diff,
              diffInlined: diff.length <= DIFF_INLINE_LIMIT,
            },
          ],
        },
      });
      current = [];
      size = 0;
    };
    for (const piece of pieces) {
      const t = piece.reduce((s, f) => s + tokensOf(diffs.get(f) ?? ""), 0);
      if (size + t > limit) flush();
      current.push(...piece);
      size += t;
    }
    flush();
  }
  return { parts };
}

/**
 * The groups of related files of every repository as the code's links make them (REQ-CTX-19/AC1), with their diffs,
 * for joining by meaning (REQ-CTX-20/AC4). Keys are `<repo>:<group>`, in a fixed order.
 *
 * @param context - The change context.
 */
export function changeGroups(
  context: ChangeContext,
): { readonly repo: string; readonly key: string; readonly files: number; readonly text: string }[] {
  const out: { repo: string; key: string; files: number; text: string }[] = [];
  for (const repo of [...context.repos].sort((a, b) => byCode(a.alias, b.alias))) {
    const diffs = fileDiffs(repo.diff);
    const groups = new Map<string, string[]>();
    for (const path of [...diffs.keys()].sort()) {
      const key = `${repo.alias}:${moduleOf(path)}`;
      groups.set(key, [...(groups.get(key) ?? []), path]);
    }
    for (const key of [...groups.keys()].sort(byCode)) {
      const files = groups.get(key) ?? [];
      // What a group is about: its paths and changed lines, without the diff's headers.
      const text = files
        .flatMap((f) => [
          f,
          ...(diffs.get(f) ?? "")
            .split("\n")
            .filter((l) => /^[+-](?![+-]{2} )/.test(l))
            .map((l) => l.slice(1)),
        ])
        .join("\n");
      out.push({ repo: repo.alias, key, files: files.length, text });
    }
  }
  return out;
}

const norm = (text: string): string => text.toLowerCase().replace(/\s+/g, " ").trim();

/** Joins sources of the same claim found by several parts, without duplicates, in a fixed order. */
function joinSources<T>(a: readonly T[], b: readonly T[]): T[] {
  const seen = new Map<string, T>();
  for (const s of [...a, ...b]) seen.set(JSON.stringify(s), s);
  return [...seen.values()];
}

/** Merges claims with the same key; the first part's wording stays, sources are joined. */
function mergeBy<T extends { readonly source: readonly unknown[] }>(
  lists: readonly (readonly T[])[],
  key: (item: T) => string,
): T[] {
  const out = new Map<string, T>();
  for (const list of lists)
    for (const item of list) {
      const k = key(item);
      const prev = out.get(k);
      out.set(k, prev ? { ...prev, source: joinSources(prev.source, item.source) } : item);
    }
  return [...out.values()];
}

const CONFIDENCE = ["low", "medium", "high"] as const;

/**
 * Merges the analyses of a change's parts into one (REQ-CTX-19/AC2): endpoints, screens and risks without duplicates
 * (their sources joined), questions renumbered without duplicates, the change types of all parts and the lowest
 * confidence. Checking every source against the change is the caller's job, as for a single analysis.
 *
 * @param parts - Each part's id and its validated analysis, in the order of the split.
 */
export function mergeAnalyses(
  parts: readonly { readonly id: string; readonly analysis: Analysis }[],
): Analysis {
  const all = parts.map((p) => p.analysis);
  const questions = new Map<string, Analysis["open_questions"][number]>();
  for (const a of all)
    for (const q of a.open_questions)
      if (!questions.has(norm(q.question))) questions.set(norm(q.question), q);
  const confidence = CONFIDENCE[Math.min(...all.map((a) => CONFIDENCE.indexOf(a.confidence)))] ?? "low";
  return AnalysisSchema.parse({
    summary: parts.map((p) => `${p.id}: ${p.analysis.summary}`).join("\n"),
    change_type: (["api", "web", "mobile"] as const).filter((t) =>
      all.some((a) => a.change_type.includes(t)),
    ),
    endpoints: mergeBy(
      all.map((a) => a.endpoints),
      (e) => `${(e.method ?? "").toUpperCase()} ${e.path}`,
    ),
    screens: mergeBy(
      all.map((a) => a.screens),
      (s) => norm(s.name),
    ),
    risks: mergeBy(
      all.map((a) => a.risks),
      (r) => norm(r.description),
    ),
    confidence,
    open_questions: [...questions.values()].map((q, i) => ({ ...q, id: `Q${String(i + 1)}` })),
  });
}
