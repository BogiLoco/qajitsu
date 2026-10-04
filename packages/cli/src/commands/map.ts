import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  QajitsuError,
  RunRecordSchema,
  listTickets,
  readRunIndex,
  resolveWorkspaceRoot,
} from "@qajitsu/core";
import {
  buildAppMap,
  normalizeRoute,
  renderAppMapHtml,
  type MapRun,
  type TransitionGraph,
} from "@qajitsu/report";
import { parse } from "yaml";
import type { RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import type { CommandIO } from "./fetch.js";

const METHODS = ["get", "post", "put", "patch", "delete"];

/** API operations of an OpenAPI document as `METHOD /path` (path parameters kept as `{name}`). */
export function openApiOperations(doc: unknown): string[] {
  const paths = (doc as { paths?: Record<string, Record<string, unknown>> } | null)?.paths ?? {};
  return Object.entries(paths).flatMap(([path, ops]) =>
    Object.keys(ops)
      .filter((m) => METHODS.includes(m.toLowerCase()))
      .map((m) => `${m.toUpperCase()} ${path}`),
  );
}

/** Rewrites a run graph so its labels use the project's route patterns and OpenAPI paths. */
const normalizeGraph = (graph: TransitionGraph, rules: readonly string[]): TransitionGraph => {
  const rename = (id: string): string => {
    if (id.startsWith("page:")) return `page:${normalizeRoute(id.slice(5), rules)}`;
    const m = /^api:(\S+) (.+)$/.exec(id);
    return m ? `api:${m[1] ?? ""} ${normalizeRoute(m[2] ?? "", rules)}` : id;
  };
  const nodes = new Map(
    graph.nodes.map((n) => {
      const id = rename(n.id);
      return [id, { ...n, id, label: id.slice(n.kind.length + 1) }];
    }),
  );
  return {
    nodes: [...nodes.values()],
    edges: graph.edges.map((e) => ({ ...e, from: rename(e.from), to: rename(e.to) })),
  };
};

/**
 * `qajitsu map [--out <dir>] [--openapi <file>]`: aggregates the transition graphs of every run into the
 * project's application map (REQ-OBS-07): what was tested, how it last ended, and which known screens
 * (`.qa/routes.yaml`) and API operations (OpenAPI) were never reached. Writes `map.json` and `map.html`.
 */
export async function runMap(
  options: { readonly out?: string | undefined; readonly openapi?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const project = await loadProject(io.cwd);
    const root = resolveWorkspaceRoot({
      configured: project.config.workspace.root,
      home: ports.home,
      cwd: project.qaDir,
    });
    const routesRaw = parse(
      await readFile(join(project.qaDir, "routes.yaml"), "utf8").catch(() => "[]"),
    ) as unknown;
    const routeList = Array.isArray(routesRaw)
      ? routesRaw
      : (routesRaw as { routes?: unknown } | null)?.routes;
    const pages = (Array.isArray(routeList) ? routeList : []).filter(
      (r): r is string => typeof r === "string" && r.startsWith("/"),
    );
    const runs: MapRun[] = [];
    let openapiText: string | undefined =
      options.openapi === undefined ? undefined : await readFile(resolve(io.cwd, options.openapi), "utf8");
    for (const ticket of await listTickets(root)) {
      for (const entry of (await readRunIndex(root, ticket)).runs) {
        const dir = join(root, ticket, entry.runId);
        const graph = JSON.parse(
          await readFile(join(dir, "report", "graph.json"), "utf8").catch(() => "null"),
        ) as TransitionGraph | null;
        const record = RunRecordSchema.safeParse(
          JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => "null")) as unknown,
        );
        if (graph && record.success && Array.isArray(graph.nodes))
          runs.push({ ticket, runId: entry.runId, at: record.data.createdAt, graph });
        // The newest worktree that still has the OpenAPI document gives the known API operations.
        for (const [alias, repo] of Object.entries(project.config.repos))
          if (options.openapi === undefined && repo.openapi !== undefined)
            openapiText =
              (await readFile(join(dir, "repos", alias, repo.openapi), "utf8").catch(() => undefined)) ??
              openapiText;
      }
    }
    const api = openapiText === undefined ? [] : openApiOperations(parse(openapiText) as unknown);
    const rules = [...pages, ...api.map((a) => a.slice(a.indexOf(" ") + 1))];
    const map = buildAppMap(
      runs.map((r) => ({ ...r, graph: normalizeGraph(r.graph, rules) })),
      { pages, api },
      ports.now(),
    );
    const out = resolve(io.cwd, options.out ?? join(project.projectDir, "qa-map"));
    await mkdir(out, { recursive: true });
    await writeFile(join(out, "map.json"), `${JSON.stringify(map, null, 2)}\n`, "utf8");
    await writeFile(join(out, "map.html"), renderAppMapHtml(map, project.config.project), "utf8");
    io.write(
      `${String(map.runs)} run(s), ${String(map.nodes.filter((n) => n.tested).length)} tested node(s), ${String(map.neverTested.length)} never tested.\n${join(out, "map.html")}\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
