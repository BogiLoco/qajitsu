import { readdir, readFile, writeFile } from "node:fs/promises";
import { readManifest } from "@qajitsu/adapter-evidence-local";
import {
  APPROVED_PLAN_FILE,
  CaseResultFileSchema,
  loadApprovedPlan,
  parseEventLines,
  sha256,
  type CaseResultFile,
  type EvidenceEntry,
  type Plan,
  type PlanApproval,
} from "@qajitsu/core";
import {
  buildTransitionGraph,
  renderGraphSvg,
  type GraphCase,
  type TransitionGraph,
  chooseSummary,
  renderMatrixCsv,
  renderMatrixMarkdown,
  renderMatrixXlsx,
  renderReportHtml,
  type MatrixRow,
  type ReportAttempt,
} from "@qajitsu/report";
import {
  checkManifest,
  combineGates,
  evaluateRun,
  gateNoSecrets,
  type CaseEvaluation,
  type GateResult,
} from "@qajitsu/verifier";
import { parse } from "yaml";
import type { RunSession } from "../session.js";

/** Environment facts recorded in `run.json` by `qj run`. */
export interface RunEnvironment {
  readonly name: string;
  readonly baseUrl: string;
  readonly deployedSha?: string | undefined;
}

/** Statuses, gates and rendered reports of a run, all computed from files on disk (invariants 1, 6, 7). */
export interface RunVerdict {
  readonly plan: Plan;
  readonly approval: PlanApproval;
  readonly environment: RunEnvironment;
  readonly results: ReadonlyMap<string, CaseResultFile>;
  readonly manifest: readonly EvidenceEntry[];
  readonly cases: readonly CaseEvaluation[];
  readonly rows: readonly MatrixRow[];
  readonly summary: string;
  readonly matrixMd: string;
  readonly csv: string;
  readonly html: string;
  readonly graph: TransitionGraph;
  readonly gates: readonly GateResult[];
  readonly ok: boolean;
  readonly failed: readonly GateResult[];
}

/**
 * Re-reads results, evidence and the approved plan of a run and computes everything a report or a
 * publication says. Nothing is taken from memory or from earlier reports, so files changed after
 * `qj run` are caught here (hash gates) instead of being published.
 *
 * @param session - Open run session.
 * @param now - Clock for the report date.
 */
export async function computeVerdict(session: RunSession, now: () => Date): Promise<RunVerdict> {
  const { ws, masker } = session;
  const { plan, approval } = await loadApprovedPlan(ws);
  const environment = (ws.record.data["environment"] as RunEnvironment | undefined) ?? {
    name: "–",
    baseUrl: "–",
  };
  const results = new Map<string, CaseResultFile>();
  const malformed: string[] = [];
  const reported: string[] = [];
  for (const file of (await readdir(ws.path("results"))).filter((f) => f.endsWith(".json"))) {
    const id = file.slice(0, -5);
    reported.push(id);
    const parsed = CaseResultFileSchema.safeParse(
      JSON.parse(await readFile(ws.path("results", file), "utf8").catch(() => "null")) as unknown,
    );
    if (parsed.success && parsed.data.caseId === id) results.set(id, parsed.data);
    else malformed.push(`results/${file}: not a valid results file`);
  }
  const manifest = await readManifest(ws.path("evidence"));
  const manifestCheck = await checkManifest(ws.path("evidence"), manifest);
  const currentSha = sha256(await readFile(ws.path("plan", APPROVED_PLAN_FILE), "utf8"));
  const evaluated = evaluateRun({
    plan,
    results,
    reportedCaseIds: reported,
    manifest,
    manifestCheck,
    approvedSha256: approval.sha256,
    currentSha256: currentSha,
  });
  const cases = evaluated.cases;
  const rows: MatrixRow[] = cases.map((c) => {
    const p = plan.cases.find((x) => x.id === c.caseId);
    return {
      caseId: c.caseId,
      title: p?.title ?? c.caseId,
      requirement: (p?.source ?? [])
        .map((s) => (s.kind === "ac" ? s.id : s.kind === "diff" ? `${s.repo}:${s.file}` : s.kind))
        .join(", "),
      type: p?.type ?? "api",
      status: c.status,
      stepsPassed: c.stepsPassed,
      stepsTotal: c.stepsTotal,
      evidence:
        c.evidence.length > 0
          ? `${String(c.evidence.length)} file(s)`
          : c.error
            ? masker.maskText(c.error).slice(0, 80)
            : "–",
    };
  });
  const summary = chooseSummary(undefined, rows).text;
  const evidenceText = new Map<string, string>();
  const evidenceBytes = new Map<string, Buffer>();
  for (const m of manifest) {
    const bytes = await readFile(ws.path("evidence", m.path)).catch(() => Buffer.alloc(0));
    evidenceBytes.set(m.path, bytes);
    if (m.kind !== "screenshot" && m.kind !== "video" && m.kind !== "trace")
      evidenceText.set(m.path, bytes.toString("utf8"));
  }

  // REQ-OBS-06: transition graph from the last attempt of every case, built by code.
  const graphCases: GraphCase[] = [...results.values()].map((r) => {
    const last = r.attempts.at(-1);
    const calls = manifest
      .filter((m) => last?.evidence.includes(m.path) === true && m.kind === "response")
      .map((m) => {
        try {
          const c = JSON.parse(evidenceText.get(m.path) ?? "{}") as { method?: string; url?: string };
          return { stepId: m.stepId ?? "", method: c.method ?? "GET", url: c.url ?? "" };
        } catch {
          return { stepId: m.stepId ?? "", method: "GET", url: "" };
        }
      });
    return {
      caseId: r.caseId,
      steps: last?.steps ?? [],
      calls,
      failedSteps: (last?.assertions ?? []).filter((a) => !a.pass).map((a) => a.stepId),
    };
  });
  const graph = buildTransitionGraph(graphCases, await routeRules(session));

  // REQ-OBS-02/AC2: timeline with links to the evidence of the moment.
  const { events } = parseEventLines(
    await readFile(ws.path("journal", "events.jsonl"), "utf8").catch(() => ""),
  );
  const timeline = events
    .filter((e) => !["tool_result", "model.usage"].includes(e.event))
    .map((e) => {
      const d = (e.details ?? {}) as Record<string, unknown>;
      const caseId = typeof d["caseId"] === "string" ? d["caseId"] : undefined;
      const attempt = typeof d["attempt"] === "number" ? d["attempt"] : undefined;
      const step = typeof d["step"] === "string" ? d["step"] : undefined;
      const prefix =
        caseId && attempt !== undefined && step ? `${caseId}/attempt-${String(attempt)}/${step}` : undefined;
      const evidencePath = prefix
        ? (
            manifest.find((x) => x.path === `${prefix}.png`) ??
            manifest.find((x) => x.path.startsWith(`${prefix}-`))
          )?.path
        : undefined;
      return {
        ts: e.ts,
        stage: e.stage,
        actor: `${e.actor.kind}:${e.actor.name}`,
        event: e.event,
        text: masker.maskText(JSON.stringify(e.details ?? {})).slice(0, 200),
        evidencePath,
      };
    });
  const attempts: Record<string, ReportAttempt[]> = {};
  for (const [id, r] of results) {
    attempts[id] = r.attempts.map((a) => ({
      attempt: a.attempt,
      outcome: a.outcome,
      error: a.error,
      assertions: a.assertions,
      evidence: manifest
        .filter((m) => a.evidence.includes(m.path))
        .map((m) => ({
          path: m.path,
          sha256: m.sha256,
          kind: m.kind,
          stepId: m.stepId,
          ...(m.kind === "screenshot"
            ? {
                dataUri: `data:image/png;base64,${(evidenceBytes.get(m.path) ?? Buffer.alloc(0)).toString("base64")}`,
              }
            : m.kind === "video" || m.kind === "trace"
              ? {}
              : { text: masker.maskText(evidenceText.get(m.path) ?? "") }),
        })),
    }));
  }
  const matrixMd = renderMatrixMarkdown(rows);
  const csv = renderMatrixCsv(rows);
  const html = (g: readonly GateResult[]): string =>
    renderReportHtml({
      ticket: ws.ticket,
      summary,
      runId: ws.runId,
      generatedAt: now().toISOString(),
      plan,
      planSha256: approval.sha256,
      rows,
      attempts,
      environment,
      repos: Object.fromEntries(Object.entries(ws.record.repos).map(([k, v]) => [k, v.sha])),
      gates: g,
      timeline,
      graphSvg: graph.edges.length > 0 ? renderGraphSvg(graph) : undefined,
    });
  const secretGate = gateNoSecrets(
    [
      { name: "matrix.md", text: matrixMd },
      { name: "matrix.csv", text: csv },
      { name: "report.html", text: html(evaluated.gates) },
      // Evidence and results leave the machine with the report (REQ-PUB-02), so they are scanned too.
      ...manifest.map((m) => ({ name: `evidence/${m.path}`, text: evidenceText.get(m.path) ?? "" })),
      ...(await Promise.all(
        reported.map(async (id) => ({
          name: `results/${id}.json`,
          text: await readFile(ws.path("results", `${id}.json`), "utf8"),
        })),
      )),
    ],
    (t) => masker.containsSecret(t),
  );
  // Every file under evidence/ must be in the manifest: unlisted files are neither hash-checked nor
  // secret-scanned, so they would leave the machine unverified (invariants 7 and 8).
  const listed = new Set(manifest.map((m) => m.path));
  const unlisted = (await listEvidenceFiles(ws.path("evidence"))).filter(
    (p) => p !== "manifest.json" && !listed.has(p),
  );
  const gates: GateResult[] = [
    ...evaluated.gates,
    secretGate,
    {
      gate: "evidence-listed",
      ok: unlisted.length === 0,
      problems: unlisted.map((p) => `evidence/${p}: not in the manifest`),
    },
    { gate: "results-valid", ok: malformed.length === 0, problems: malformed },
  ];
  const verdict = combineGates(gates);
  return {
    plan,
    approval,
    environment,
    results,
    manifest,
    cases,
    rows,
    summary,
    matrixMd,
    csv,
    html: masker.maskText(html(gates)),
    graph,
    gates,
    ok: verdict.ok,
    failed: verdict.failed,
  };
}

/** Route patterns from `.qa/routes.yaml` (a list, or `routes:` with a list) for URL normalisation (REQ-OBS-06/AC3). */
async function routeRules(session: RunSession): Promise<string[]> {
  try {
    const raw = parse(await readFile(`${session.project.qaDir}/routes.yaml`, "utf8")) as unknown;
    const list = Array.isArray(raw) ? raw : (raw as { routes?: unknown } | null)?.routes;
    return Array.isArray(list)
      ? list.filter((r): r is string => typeof r === "string" && r.startsWith("/"))
      : [];
  } catch {
    return [];
  }
}

/** Relative paths of every file under `evidence/`. */
export async function listEvidenceFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await listEvidenceFiles(`${dir}/${entry.name}`, rel)));
    else out.push(rel);
  }
  return out;
}

/** Writes `report/matrix.md`, `.csv`, `.xlsx`, `report.html` and `gates.json` (REQ-EVD-05). */
export async function writeReports(session: RunSession, v: RunVerdict): Promise<void> {
  const { ws } = session;
  await writeFile(ws.path("report", "matrix.md"), v.matrixMd, "utf8");
  await writeFile(ws.path("report", "matrix.csv"), v.csv, "utf8");
  await writeFile(ws.path("report", "matrix.xlsx"), renderMatrixXlsx(v.rows));
  await writeFile(ws.path("report", "report.html"), v.html, "utf8");
  await writeFile(ws.path("report", "graph.json"), `${JSON.stringify(v.graph, null, 2)}\n`, "utf8");
  await writeFile(
    ws.path("report", "gates.json"),
    `${JSON.stringify({ ok: v.ok, gates: v.gates }, null, 2)}\n`,
    "utf8",
  );
}
