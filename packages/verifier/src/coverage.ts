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
const exclusionOf = (plan: Plan, id: string): string | undefined => {
  for (const entry of plan.out_of_scope) {
    // "AC3: why" or "GET /cart-items — why": a colon or a spaced dash separates the id from the reason.
    const m = /^\s*(.+?)(?::\s+|\s+[—–-]\s+)(\S.*)$/.exec(entry);
    if (m !== null && normalize(m[1] ?? "") === normalize(id)) return m[2];
  }
  return undefined;
};

/** Whether a step action calls the endpoint (`POST /orders/42/cancel` calls `POST /orders/{id}/cancel`). */
const calls = (action: string, method: string | undefined, path: string): boolean => {
  const template = path
    .replace(/[.*+?^$()|[\]\\]/g, "\\$&")
    .replace(/\\?\{[^}]+\\?\}|:[A-Za-z_]\w*/g, "[^/\\s?]+");
  const verb = method ? `${method.toUpperCase()}\\s+` : "(?:GET|POST|PUT|PATCH|DELETE)\\s+";
  return new RegExp(`\\b${verb}${template}(?=$|[\\s?])`, "i").test(action);
};

/** One row of the coverage matrix: a criterion or an endpoint and what covers it (REQ-WEB-07/AC2). */
export interface CoverageRow {
  readonly kind: "criterion" | "endpoint";
  /** `AC2` or `POST /orders/{id}/cancel`. */
  readonly id: string;
  /** The criterion's text; the endpoint has none. */
  readonly text?: string;
  /** Cases that cover it (an `ac` source or a quote of the criterion; a call to the endpoint or opening the page). */
  readonly cases: readonly string[];
  /** Existing tests (`repo/file`) that cover the criterion. */
  readonly existing: readonly string[];
  /** The reason in `out_of_scope` when it is excluded on purpose. */
  readonly excluded?: string;
  readonly covered: boolean;
}

/**
 * The coverage matrix, computed by code (REQ-PLAN-14, REQ-WEB-07/AC2): every acceptance criterion with the cases that
 * cover it (an `ac` source, a quote of the criterion), the existing tests that cover it, or its exclusion with a
 * reason in `out_of_scope` (`AC3: why`); every endpoint the analysis found in the diff with the cases that call it (or
 * open the page) or its exclusion (`POST /orders: why`). The agent's claims are not trusted: only sources and step
 * actions count.
 *
 * @param plan - The plan version.
 * @param change - The ticket's acceptance criteria and the endpoints of the change.
 */
export function coverageMatrix(
  plan: Plan,
  change: {
    readonly acceptanceCriteria: readonly string[];
    readonly endpoints: readonly { readonly method?: string | undefined; readonly path: string }[];
  },
): CoverageRow[] {
  const rows: CoverageRow[] = [];
  change.acceptanceCriteria.forEach((criterion, i) => {
    const id = `AC${String(i + 1)}`;
    const quoted = (text: string): boolean => {
      const labelled = /^\s*AC(\d+)\s*:/.exec(text);
      if (labelled) return labelled[1] === String(i + 1);
      const q = normalize(text);
      return q.length >= 12 && normalize(criterion).includes(q);
    };
    const cases = plan.cases
      .filter((c) =>
        c.source.some((s) => (s.kind === "ac" && s.id === id) || (s.kind === "quote" && quoted(s.text))),
      )
      .map((c) => c.id);
    const existing = plan.existing_coverage
      .filter((e) => e.covers.includes(id))
      .map((e) => `${e.repo}/${e.file}`);
    const excluded = exclusionOf(plan, id);
    rows.push({
      kind: "criterion",
      id,
      text: criterion,
      cases,
      existing,
      ...(excluded === undefined ? {} : { excluded }),
      covered: cases.length > 0 || existing.length > 0 || excluded !== undefined,
    });
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
    const cases = plan.cases
      .filter((c) => opens(c) || c.steps.some((s) => calls(s.action, e.method, e.path)))
      .map((c) => c.id);
    const excluded = exclusionOf(plan, id) ?? exclusionOf(plan, e.path);
    rows.push({
      kind: "endpoint",
      id,
      cases,
      existing: [],
      ...(excluded === undefined ? {} : { excluded }),
      covered: cases.length > 0 || excluded !== undefined,
    });
  }
  return rows;
}

/**
 * What of the ticket and the change the plan covers, computed by code (REQ-PLAN-14): the rows of
 * {@link coverageMatrix} that nothing covers, so the matrix the reviewer sees and the gaps approval checks are one rule.
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
  return coverageMatrix(plan, change)
    .filter((r) => !r.covered)
    .map((r) =>
      r.text === undefined ? { kind: r.kind, id: r.id } : { kind: r.kind, id: r.id, text: r.text },
    );
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
