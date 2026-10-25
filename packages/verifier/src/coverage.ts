import type { Plan } from "@qajitsu/core";

/** An acceptance criterion or a changed endpoint that no case covers (REQ-PLAN-14). */
export interface CoverageGap {
  readonly kind: "criterion" | "endpoint";
  /** `AC2` or `POST /orders/{id}/cancel`. */
  readonly id: string;
  /** The criterion's text; the endpoint has none. */
  readonly text?: string;
}

const normalize = (s: string): string => s.toLowerCase().replace(/\s+/g, " ").trim();

/** `AC3: why` or `POST /orders: why` in out_of_scope: an exclusion on purpose, with its reason. */
const excluded = (plan: Plan, id: string): boolean =>
  plan.out_of_scope.some((entry) => {
    // "AC3: why" or "GET /cart-items — why": a colon or a spaced dash separates the id from the reason.
    const m = /^\s*(.+?)(?::\s+|\s+[—–-]\s+)(\S.*)$/.exec(entry);
    return m !== null && normalize(m[1] ?? "") === normalize(id);
  });

/** Whether a step action calls the endpoint (`POST /orders/42/cancel` calls `POST /orders/{id}/cancel`). */
const calls = (action: string, method: string | undefined, path: string): boolean => {
  const template = path
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\\?\{[^}]+\\?\}|:[A-Za-z_]\w*/g, "[^/\\s?]+");
  const verb = method ? `${method.toUpperCase()}\\s+` : "(?:GET|POST|PUT|PATCH|DELETE)\\s+";
  return new RegExp(`\\b${verb}${template}(?=$|[\\s?])`, "i").test(action);
};

/**
 * What of the ticket and the change the plan covers, computed by code (REQ-PLAN-14): every acceptance criterion maps
 * to a case (an `ac` source, a quote of the criterion), to an existing test that covers it, or to an exclusion with a
 * reason in `out_of_scope` (`AC3: why`); every endpoint the analysis found in the diff maps to a case that calls it or
 * to an exclusion (`POST /orders: why`). The agent's claims are not trusted: only sources and step actions count.
 *
 * @param plan - The plan version.
 * @param change - The ticket's acceptance criteria and the endpoints of the change.
 * @returns What no case covers; empty when everything is covered or excluded on purpose.
 */
export function checkPlanCoverage(
  plan: Plan,
  change: {
    readonly acceptanceCriteria: readonly string[];
    readonly endpoints: readonly { readonly method?: string | undefined; readonly path: string }[];
  },
): CoverageGap[] {
  const gaps: CoverageGap[] = [];
  change.acceptanceCriteria.forEach((criterion, i) => {
    const id = `AC${String(i + 1)}`;
    const quoted = (text: string): boolean => {
      const labelled = /^\s*AC(\d+)\s*:/.exec(text);
      if (labelled) return labelled[1] === String(i + 1);
      const q = normalize(text);
      return q.length >= 12 && normalize(criterion).includes(q);
    };
    const byCase = plan.cases.some((c) =>
      c.source.some((s) => (s.kind === "ac" && s.id === id) || (s.kind === "quote" && quoted(s.text))),
    );
    const byExisting = plan.existing_coverage.some((e) => e.covers.includes(id));
    if (!byCase && !byExisting && !excluded(plan, id)) gaps.push({ kind: "criterion", id, text: criterion });
  });
  for (const e of change.endpoints) {
    const id = `${e.method ? `${e.method.toUpperCase()} ` : ""}${e.path}`;
    // A page path (no method) is covered by a web or mobile case that opens it (dogfood pass 2026-10-25).
    const opens = (c: Plan["cases"][number]): boolean =>
      e.method === undefined &&
      c.type !== "api" &&
      c.steps.some((s) =>
        new RegExp(`(^|[\\s("'\`])${e.path.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&")}(?=$|[\\s)"'\`?#,.])`).test(
          s.action,
        ),
      );
    const byCase = plan.cases.some((c) => opens(c) || c.steps.some((s) => calls(s.action, e.method, e.path)));
    if (!byCase && !excluded(plan, id) && !excluded(plan, e.path)) gaps.push({ kind: "endpoint", id });
  }
  return gaps;
}

/** The gaps as lines next to the plan (REQ-PLAN-14/AC3). */
export function formatCoverageGaps(gaps: readonly CoverageGap[]): string {
  if (gaps.length === 0) return "";
  return [
    ...gaps.map((g) =>
      g.kind === "criterion" ? `  ? ${g.id} "${g.text ?? ""}"` : `  ? ${g.id} changed in the diff`,
    ),
    `  Add a case, or exclude each on purpose in out_of_scope with a reason, e.g. "${gaps[0]?.id ?? "AC1"}: why".`,
  ].join("\n");
}

/** A changed endpoint and the cases whose pages reached it in the run (REQ-EVD-09/AC2). */
export interface EndpointReach {
  /** `POST /orders/{id}/cancel`, or a page path. */
  readonly id: string;
  /** Cases whose recorded requests reached it; empty when none did. */
  readonly cases: readonly string[];
}

/**
 * Which case reached which endpoint of the change, from the requests the runner recorded (REQ-EVD-09/AC2): a
 * templated path matches a real id, an endpoint without a method matches any method. Only recorded traffic counts,
 * never a model's claim.
 *
 * @param endpoints - Endpoints of the change, from the analysis.
 * @param reached - Requests per case, as the runner recorded them.
 */
export function endpointReach(
  endpoints: readonly { readonly method?: string | undefined; readonly path: string }[],
  reached: ReadonlyMap<string, readonly { readonly method: string; readonly path: string }[]>,
): EndpointReach[] {
  return endpoints.map((e) => {
    const template = new RegExp(
      `^${e.path
        .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
        .replace(/\\?\{[^}]+\\?\}|:[A-Za-z_]\w*/g, "[^/?]+")}/?$`,
    );
    const cases = [...reached]
      .filter(([, requests]) =>
        requests.some(
          (r) =>
            (e.method === undefined || r.method.toUpperCase() === e.method.toUpperCase()) &&
            template.test(r.path),
        ),
      )
      .map(([caseId]) => caseId)
      .sort();
    return { id: `${e.method ? `${e.method.toUpperCase()} ` : ""}${e.path}`, cases };
  });
}
