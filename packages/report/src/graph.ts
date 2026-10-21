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
  const w = 240;
  const h = 110;
  const boxW = 180;
  const boxH = 40;
  const top = 30;
  const pos = new Map(
    graph.nodes.map((n, i) => [n.id, { x: 20 + (i % cols) * w, y: top + Math.floor(i / cols) * h }]),
  );
  // Room on the right of the last column for loops and their labels.
  const width = 100 + cols * w;
  const rows = Math.ceil(graph.nodes.length / cols);
  const height = top + (rows - 1) * h + boxH + 30;
  const center = (p: { x: number; y: number }) => ({ x: p.x + boxW / 2, y: p.y + boxH / 2 });
  // REQ-OBS-06/AC4: where the line from a box's centre towards `toward` leaves the box (3 px outside it).
  const border = (c: { x: number; y: number }, toward: { x: number; y: number }) => {
    const dx = toward.x - c.x;
    const dy = toward.y - c.y;
    const t = Math.min(
      dx === 0 ? Infinity : (boxW / 2 + 3) / Math.abs(dx),
      dy === 0 ? Infinity : (boxH / 2 + 3) / Math.abs(dy),
    );
    return { x: c.x + dx * t, y: c.y + dy * t };
  };
  const n = (v: number) => String(Math.round(v * 10) / 10);
  const color = (o: GraphEdge["outcome"]) => (o === "passed" ? "#1a7f37" : "#cf222e");
  const label = (x: number, y: number, e: GraphEdge) =>
    `<text x="${n(x)}" y="${n(y)}" text-anchor="middle" font-size="10" fill="${color(e.outcome)}" stroke="#fff" stroke-width="3" paint-order="stroke">${esc(e.label)}</text>`;
  // Edges between the same two nodes, in either direction, are spread apart.
  const groups = new Map<string, GraphEdge[]>();
  for (const e of graph.edges) {
    const key = [e.from, e.to].sort().join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), e]);
  }
  const lines = graph.edges.map((e) => {
    const a = pos.get(e.from);
    const b = pos.get(e.to);
    if (!a || !b) return "";
    const group = groups.get([e.from, e.to].sort().join("\u0000")) ?? [e];
    const index = group.indexOf(e);
    const attrs = `stroke="${color(e.outcome)}" stroke-width="2" fill="none" marker-end="url(#arrow-${e.outcome})"`;
    const title = `<title>${esc(e.label)} (${e.outcome})</title>`;
    if (e.from === e.to) {
      // A loop on the right side of the box, wider for each further loop, clear of the edges between rows.
      const c = center(a);
      const r = 16 + index * 12;
      const x0 = a.x + boxW + 3;
      const d = `M${n(x0)} ${n(c.y - 9)}C${n(x0 + 2 * r)} ${n(c.y - 9 - r)} ${n(x0 + 2 * r)} ${n(c.y + 9 + r)} ${n(x0)} ${n(c.y + 9)}`;
      return `<g><path class="edge" d="${d}" ${attrs}>${title}</path>${label(x0 + 1.5 * r + 22, c.y + 4, e)}</g>`;
    }
    const ca = center(a);
    const cb = center(b);
    // Curve sideways by the edge's place in its group; the canonical direction keeps A→B and B→A apart.
    const sign = e.from < e.to ? 1 : -1;
    const offset = (index - (group.length - 1) / 2) * 34 * sign + (group.length > 1 ? 0 : 0);
    const len = Math.hypot(cb.x - ca.x, cb.y - ca.y) || 1;
    const normal = { x: -(cb.y - ca.y) / len, y: (cb.x - ca.x) / len };
    const mid = {
      x: (ca.x + cb.x) / 2 + normal.x * offset * 2,
      y: (ca.y + cb.y) / 2 + normal.y * offset * 2,
    };
    const start = border(ca, mid);
    const end = border(cb, mid);
    const d = `M${n(start.x)} ${n(start.y)}Q${n(mid.x)} ${n(mid.y)} ${n(end.x)} ${n(end.y)}`;
    // The label sits on the curve, halfway.
    const lx = 0.25 * start.x + 0.5 * mid.x + 0.25 * end.x;
    const ly = 0.25 * start.y + 0.5 * mid.y + 0.25 * end.y;
    return `<g><path class="edge" d="${d}" ${attrs}>${title}</path>${label(lx, ly - 4, e)}</g>`;
  });
  const boxes = graph.nodes.map((node) => {
    const p = pos.get(node.id);
    if (!p) return "";
    const fill = node.kind === "page" ? "#ddf4ff" : "#fff8c5";
    return `<g><rect x="${String(p.x)}" y="${String(p.y)}" width="${String(boxW)}" height="${String(boxH)}" rx="6" fill="${fill}" stroke="#57606a"/><text x="${String(p.x + boxW / 2)}" y="${String(p.y + 25)}" text-anchor="middle" font-size="12">${esc(node.label.length > 26 ? `${node.label.slice(0, 25)}…` : node.label)}</text></g>`;
  });
  const marker = (o: string, c: string): string =>
    `<marker id="arrow-${o}" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0 0L10 5L0 10z" fill="${c}"/></marker>`;
  // Boxes first, then edges: the arrowheads stay visible on the boxes' borders.
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(height)}" role="img" aria-label="Transition graph"><defs>${marker("passed", "#1a7f37")}${marker("failed", "#cf222e")}</defs>${boxes.join("")}${lines.join("")}</svg>`;
}
