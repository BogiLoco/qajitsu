import type { Depth, PlanDraft } from "./schemas.js";

const KEPT: Readonly<Record<Depth, readonly string[]>> = {
  smoke: ["high"],
  standard: ["high", "medium"],
  full: ["high", "medium", "low"],
};
const ORDER = ["high", "medium", "low"] as const;

/**
 * Selects the planner's cases for a test depth by their risk (priority) and records why each one is in or out
 * (REQ-PLAN-08/AC1). Code decides, not the model: smoke keeps high, standard high and medium, full everything. When no
 * case reaches the depth, the highest priority present is kept so the plan is never empty. Left-out cases are listed
 * in `out_of_scope` too, so a reviewer sees them.
 *
 * @param draft - The planner's draft.
 * @param depth - The chosen depth.
 */
export function applyDepth(draft: PlanDraft, depth: Depth): PlanDraft {
  const present = ORDER.filter((p) => draft.cases.some((c) => c.priority === p));
  const wanted = KEPT[depth];
  const fallback = !present.some((p) => wanted.includes(p));
  const kept = fallback ? present.slice(0, 1) : wanted;
  const selection = draft.cases.map((c) => {
    const included = kept.includes(c.priority);
    const reason = included
      ? fallback
        ? `no case reaches depth ${depth}; the highest priority present (${c.priority}) is kept`
        : `priority ${c.priority} is part of depth ${depth}`
      : `priority ${c.priority} is below depth ${depth}`;
    return { case: c.id, title: c.title, priority: c.priority, included, reason };
  });
  return {
    ...draft,
    cases: draft.cases.filter((c) => kept.includes(c.priority)),
    out_of_scope: [
      ...draft.out_of_scope,
      ...selection.filter((s) => !s.included).map((s) => `${s.case} ${s.title} (${s.reason})`),
    ],
    depth,
    selection,
  };
}
