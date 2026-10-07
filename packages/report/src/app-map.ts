import type { GraphEdge, GraphNode, TransitionGraph } from "./graph.js";
import { renderGraphSvg } from "./graph.js";
import type { MapAround } from "@qajitsu/core";

/** One run's transition graph (`report/graph.json`) with where it came from. */
export interface MapRun {
  readonly ticket: string;
  readonly runId: string;
  readonly at: string;
  readonly graph: TransitionGraph;
}

/** A node of the application map. */
export interface MapNode extends GraphNode {
  readonly tested: boolean;
  readonly tickets: readonly string[];
  readonly lastTested?: string | undefined;
}

/** A transition of the application map, aggregated over runs. */
export interface MapEdge {
  readonly from: string;
  readonly to: string;
  readonly passed: number;
  readonly failed: number;
  readonly lastOutcome: GraphEdge["outcome"];
  readonly lastTested: string;
  readonly tickets: readonly string[];
}

/** The project map (REQ-OBS-07): everything tested across runs and what is known but never tested. */
export interface AppMap {
  readonly generatedAt: string;
  readonly runs: number;
  readonly nodes: readonly MapNode[];
  readonly edges: readonly MapEdge[];
  /** Known screens and endpoints no run ever reached. */
  readonly neverTested: readonly string[];
}

/**
 * Aggregates per-run transition graphs into a project map (REQ-OBS-07/AC1). Known screens (route
 * patterns) and API operations (from OpenAPI) that never appear in a run are listed as never tested.
 * Built by code from recorded results, never by an agent.
 *
 * @param runs - Graphs of every run, oldest first.
 * @param known - Known page route patterns and API operations (`GET /cart`).
 * @param now - Generation time.
 */
export function buildAppMap(
  runs: readonly MapRun[],
  known: { readonly pages: readonly string[]; readonly api: readonly string[] },
  now: Date,
): AppMap {
  const nodes = new Map<string, { node: GraphNode; tickets: Set<string>; last?: string }>();
  const edges = new Map<string, { edge: MapEdge; tickets: Set<string> }>();
  const sorted = [...runs].sort((a, b) => a.at.localeCompare(b.at));
  for (const run of sorted) {
    for (const n of run.graph.nodes) {
      const entry = nodes.get(n.id) ?? { node: n, tickets: new Set<string>() };
      entry.tickets.add(run.ticket);
      entry.last = run.at;
      nodes.set(n.id, entry);
    }
    for (const e of run.graph.edges) {
      const key = `${e.from}→${e.to}`;
      const entry = edges.get(key);
      const passed = (entry?.edge.passed ?? 0) + (e.outcome === "passed" ? 1 : 0);
      const failed = (entry?.edge.failed ?? 0) + (e.outcome === "failed" ? 1 : 0);
      const tickets = entry?.tickets ?? new Set<string>();
      tickets.add(run.ticket);
      edges.set(key, {
        edge: {
          from: e.from,
          to: e.to,
          passed,
          failed,
          lastOutcome: e.outcome,
          lastTested: run.at,
          tickets: [],
        },
        tickets,
      });
    }
  }
  const knownIds = [...known.pages.map((p) => `page:${p}`), ...known.api.map((a) => `api:${a}`)];
  for (const id of knownIds)
    if (!nodes.has(id)) {
      const kind = id.startsWith("page:") ? "page" : "api";
      nodes.set(id, { node: { id, kind, label: id.slice(kind.length + 1) }, tickets: new Set() });
    }
  const mapNodes: MapNode[] = [...nodes.values()].map(({ node, tickets, last }) => ({
    ...node,
    tested: tickets.size > 0,
    tickets: [...tickets].sort(),
    ...(last ? { lastTested: last } : {}),
  }));
  return {
    generatedAt: now.toISOString(),
    runs: runs.length,
    nodes: mapNodes,
    edges: [...edges.values()].map(({ edge, tickets }) => ({ ...edge, tickets: [...tickets].sort() })),
    neverTested: mapNodes
      .filter((n) => !n.tested && n.id !== "page:start")
      .map((n) => n.id)
      .sort(),
  };
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/**
 * Renders the map as a static page without scripts (REQ-OBS-07/AC2): the graph (green when the last
 * run of a transition passed, red when it failed, untested nodes grey) and tables of transitions and of
 * screens and endpoints never tested.
 *
 * @param map - The application map.
 * @param project - Project name for the title.
 */
export function renderAppMapHtml(map: AppMap, project: string): string {
  const svg = renderGraphSvg({
    nodes: map.nodes,
    edges: map.edges.map((e) => ({
      from: e.from,
      to: e.to,
      label: `${String(e.passed)} passed, ${String(e.failed)} failed`,
      outcome: e.lastOutcome,
    })),
  });
  const untested = new Set(map.neverTested);
  const greyed = map.nodes.reduce(
    (html, n) =>
      untested.has(n.id)
        ? html.replace(
            `>${esc(n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label)}</text>`,
            ` fill="#8c959f">${esc(n.label.length > 26 ? `${n.label.slice(0, 25)}…` : n.label)} (never)</text>`,
          )
        : html,
    svg,
  );
  const rows = map.edges
    .map(
      (e) =>
        `<tr><td>${esc(e.from)}</td><td>${esc(e.to)}</td><td>${String(e.passed)}</td><td>${String(e.failed)}</td><td class="${e.lastOutcome}">${e.lastOutcome}</td><td>${esc(e.lastTested)}</td><td>${esc(e.tickets.join(", "))}</td></tr>`,
    )
    .join("");
  const never = map.neverTested.map((id) => `<li>${esc(id)}</li>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><title>QAJitsu map: ${esc(project)}</title><style>body{font:14px system-ui,sans-serif;margin:24px;color:#1f2328}table{border-collapse:collapse}td,th{border:1px solid #d0d7de;padding:4px 8px;text-align:left}.passed{color:#1a7f37}.failed{color:#cf222e}.graph{overflow:auto;border:1px solid #d0d7de;padding:8px}</style></head><body>
<h1>Application map: ${esc(project)}</h1>
<p>${String(map.runs)} run(s), ${String(map.nodes.filter((n) => n.tested).length)} tested node(s), ${String(map.edges.length)} transition(s), ${String(map.neverTested.length)} never tested. Generated ${esc(map.generatedAt)}.</p>
<h2>Graph</h2><div class="graph">${greyed}</div>
<h2>Never tested</h2>${never ? `<ul>${never}</ul>` : "<p>Every known screen and endpoint was reached at least once.</p>"}
<h2>Transitions</h2><table><tr><th>From</th><th>To</th><th>Passed</th><th>Failed</th><th>Last</th><th>Last tested</th><th>Tickets</th></tr>${rows}</table>
</body></html>
`;
}

/** What a change touches, from the analysis and the diff. */
export interface ChangeFootprint {
  /** Endpoints as `METHOD /path` or `/path` (any method). */
  readonly endpoints: readonly string[];
  /** Screen names from the analysis. */
  readonly screens: readonly string[];
  /** Changed file paths. */
  readonly files: readonly string[];
}

const PARAM = /^(\{[^}]+\}|:[^/]+)$/;
const segments = (path: string): string[] => path.split("?")[0]?.split("/").filter(Boolean) ?? [];
const staticSegments = (path: string): string[] =>
  segments(path)
    .filter((s) => !PARAM.test(s))
    .map((s) => s.toLowerCase());

/** True when a concrete or templated path matches a map path (`{id}` and `:id` match any segment). */
const samePath = (a: string, b: string): boolean => {
  const x = segments(a);
  const y = segments(b);
  return x.length === y.length && x.every((s, i) => s === y[i] || PARAM.test(s) || PARAM.test(y[i] ?? ""));
};

const words = (text: string): Set<string> =>
  new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean),
  );

/**
 * The part of the application map around a change (REQ-OBS-08), computed by code: map nodes the change touches
 * (endpoints of the analysis; screens whose route words appear in a screen name or a changed file path), known
 * screens and endpoints in the same area that no run reached, and the transitions from or to a touched node.
 *
 * @param map - The project's application map.
 * @param change - What the change touches.
 * @returns The map around the change; empty lists when nothing matches.
 */
export function mapAroundChange(map: AppMap, change: ChangeFootprint): MapAround {
  const changedIds = new Set<string>();
  for (const n of map.nodes) {
    const label = n.label;
    if (n.kind === "api") {
      const [method, path = ""] = label.includes(" ") ? label.split(" ", 2) : ["", label];
      if (
        change.endpoints.some((e) => {
          const [m, p] = e.includes(" ") ? e.split(" ", 2) : ["", e];
          return (m === "" || m?.toUpperCase() === method) && samePath(p ?? "", path);
        })
      )
        changedIds.add(n.id);
    } else {
      const route = staticSegments(label);
      if (route.length === 0) continue;
      const haystacks = [...change.screens, ...change.files].map(words);
      if (haystacks.some((w) => route.every((s) => [...words(s)].every((x) => w.has(x)))))
        changedIds.add(n.id);
    }
  }
  const areas = new Set(
    [...changedIds].map((id) => staticSegments(id.slice(id.indexOf(":") + 1).replace(/^[A-Z]+ /, ""))[0]),
  );
  const nodeById = new Map(map.nodes.map((n) => [n.id, n]));
  const untested = map.nodes
    .filter((n) => !n.tested && !changedIds.has(n.id))
    .flatMap((n) => {
      const area = staticSegments(n.label.replace(/^[A-Z]+ /, ""))[0];
      if (area === undefined || !areas.has(area)) return [];
      // The closest touched node: same kind first, then in id order, so the result does not depend on map order.
      const near = [...changedIds]
        .filter((id) => staticSegments(id.slice(id.indexOf(":") + 1).replace(/^[A-Z]+ /, ""))[0] === area)
        .sort(
          (x, y) => Number(!x.startsWith(n.kind)) - Number(!y.startsWith(n.kind)) || x.localeCompare(y),
        )[0];
      return near === undefined ? [] : [{ id: n.id, near }];
    });
  return {
    generatedAt: map.generatedAt,
    runs: map.runs,
    changed: [...changedIds].sort().map((id) => {
      const n = nodeById.get(id);
      return {
        id,
        tested: n?.tested === true,
        tickets: [...(n?.tickets ?? [])],
        ...(n?.lastTested ? { lastTested: n.lastTested } : {}),
      };
    }),
    untested: untested.sort((a, b) => a.id.localeCompare(b.id)),
    transitions: map.edges
      .filter((e) => changedIds.has(e.from) || changedIds.has(e.to))
      .map((e) => ({
        from: e.from,
        to: e.to,
        passed: e.passed,
        failed: e.failed,
        lastOutcome: e.lastOutcome,
      })),
  };
}
