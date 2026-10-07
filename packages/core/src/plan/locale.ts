import type { Plan } from "./schemas.js";

/**
 * The approved plan as one locale sees it (REQ-EXEC-14/AC2): every expectation takes the values of its
 * `by_locale[locale]` override, so runtime, sandbox and evaluation read the locale's number, date and currency formats
 * through `plan.expect` like any other expectation. Only cases that run in the locale are kept. The approved plan and
 * its hash are not touched; this copy is derived from it.
 *
 * @param plan - The approved plan.
 * @param locale - Locale name, e.g. `pl-PL`.
 */
export function planForLocale(plan: Plan, locale: string): Plan {
  return {
    ...plan,
    cases: plan.cases
      .filter((c) => c.locales?.includes(locale) === true)
      .map((c) => ({
        ...c,
        steps: c.steps.map((step) => {
          const o = step.expect.by_locale?.[locale];
          if (!o) return step;
          const e = step.expect;
          return {
            ...step,
            expect: {
              ...e,
              ...(o.fields ? { fields: { ...e.fields, ...o.fields } } : {}),
              ...(o.texts ? { texts: o.texts } : {}),
              ...(o.elements
                ? {
                    elements: Object.fromEntries(
                      Object.entries(e.elements ?? {}).map(([sel, state]) => [
                        sel,
                        { ...state, ...o.elements?.[sel] },
                      ]),
                    ),
                  }
                : {}),
            },
          };
        }),
      })),
  };
}
