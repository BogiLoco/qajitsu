/** A route pattern rule, e.g. `/product/:id` (REQ-OBS-06/AC3). */
export type RoutePattern = string;

/** One node: a page (route pattern) or an API endpoint (template). */
export interface GraphNode {
  readonly id: string;
  readonly kind: "page" | "api";
  readonly label: string;
}

/** One tester action between two nodes, coloured by outcome (REQ-OBS-06/AC2). */
export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly label: string;
  readonly outcome: "passed" | "failed";
}

/** Transition graph of a run, built by code from results (never by an agent). */
export interface TransitionGraph {
  readonly nodes: readonly GraphNode[];
  readonly edges: readonly GraphEdge[];
}

/** What the graph is built from: the last attempt of every case. */
export interface GraphCase {
  readonly caseId: string;
  readonly steps: readonly { readonly id: string; readonly ok: boolean; readonly url?: string | undefined }[];
  readonly calls: readonly { readonly stepId: string; readonly method: string; readonly url: string }[];
  readonly failedSteps: readonly string[];
}

const matchPattern = (pattern: string, path: string): boolean => {
  const p = pattern.replace(/\/+$/, "").split("/");
  const s = path.replace(/\/+$/, "").split("/");
  return (
    p.length === s.length && p.every((seg, i) => seg.startsWith(":") || /^\{.+\}$/.test(seg) || seg === s[i])
  );
};

/**
 * Normalises a URL path to a route pattern (REQ-OBS-06/AC3): the first matching rule from `.qa/` or
 * the OpenAPI templates, otherwise numeric, UUID and long hex segments become `:id`.
 *
 * @param path - Concrete path, e.g. `/product/42`.
 * @param rules - Known patterns.
 */
export function normalizeRoute(path: string, rules: readonly RoutePattern[] = []): string {
  const clean = path.split("?")[0] ?? path;
  const rule = rules.find((r) => matchPattern(r, clean));
  if (rule) return rule.replace(/\{([^}]+)\}/g, ":$1");
  return clean
    .split("/")
    .map((seg) =>
      /^\d+$/.test(seg) ||
      /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(seg) ||
      /^[0-9a-f]{12,}$/i.test(seg) ||
      /^[A-Z]+-\d+$/.test(seg)
        ? ":id"
        : seg,
    )
    .join("/");
}

/**
 * Builds the transition graph: each step of a case moves from the previous node to the page it ended
 * on (UI) or to the endpoint of its last call (API); failed steps colour their edge red.
 *
 * @param cases - Cases with steps, calls and failed steps of their last attempt.
 * @param rules - Route patterns for normalisation.
 */
export function buildTransitionGraph(
  cases: readonly GraphCase[],
  rules: readonly RoutePattern[] = [],
): TransitionGraph {
  const nodes = new Map<string, GraphNode>();
  const edges: GraphEdge[] = [];
  const node = (kind: GraphNode["kind"], label: string): string => {
    const id = `${kind}:${label}`;
    if (!nodes.has(id)) nodes.set(id, { id, kind, label });
    return id;
  };
  for (const c of cases) {
    let previous = node("page", "start");
    for (const step of c.steps) {
      const call = c.calls.filter((x) => x.stepId === step.id).at(-1);
      let target: string | undefined;
      if (step.url) {
        try {
          target = node("page", normalizeRoute(new URL(step.url).pathname, rules));
        } catch {
          target = undefined;
        }
      }
      if (target === undefined && call) {
        let path = call.url;
        try {
          path = new URL(call.url).pathname;
        } catch {
          // keep the raw value
        }
        target = node("api", `${call.method} ${normalizeRoute(path, rules)}`);
      }
      if (target === undefined) continue;
      edges.push({
        from: previous,
        to: target,
        label: `${c.caseId}.${step.id}`,
        outcome: step.ok && !c.failedSteps.includes(step.id) ? "passed" : "failed",
      });
      previous = target;
    }
  }
  return { nodes: [...nodes.values()], edges };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Renders the graph as inline SVG for `report.html` (no scripts, works under the report's CSP).
 * Nodes are laid out in a grid in order of first appearance; edges are straight lines.
 *
 * @param graph - Transition graph.
 */
export function renderGraphSvg(graph: TransitionGraph): string {
  const cols = Math.max(1, Math.ceil(Math.sqrt(graph.nodes.length)));
  const w = 220;
  const h = 90;
  const pos = new Map(
    graph.nodes.map((n, i) => [n.id, { x: 20 + (i % cols) * w, y: 20 + Math.floor(i / cols) * h }]),
  );
  const width = 40 + cols * w;
  const height = 40 + Math.ceil(graph.nodes.length / cols) * h;
  const lines = graph.edges.map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return "";
    const color = e.outcome === "passed" ? "#1a7f37" : "#cf222e";
    return `<line x1="${String(a.x + 90)}" y1="${String(a.y + 20)}" x2="${String(b.x + 90)}" y2="${String(b.y + 20)}" stroke="${color}" stroke-width="2" marker-end="url(#arrow-${e.outcome})"><title>${esc(e.label)} (${e.outcome})</title></line>`;
  });
  const boxes = graph.nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return "";
    const fill = n.kind === "page" ? "#ddf4ff" : "#fff8c5";
    return `<g><rect x="${String(p.x)}" y="${String(p.y)}" width="180" height="40" rx="6" fill="${fill}" stroke="#57606a"/><text x="${String(p.x + 90)}" y="${String(p.y + 25)}" text-anchor="middle" font-size="12">${esc(n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label)}</text></g>`;
  });
  const marker = (o: string, c: string): string =>
    `<marker id="arrow-${o}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" role="img" aria-label="Transition graph"><defs>${marker("passed", "#1a7f37")}${marker("failed", "#cf222e")}</defs>${lines.join("")}${boxes.join("")}</svg>`;
}
