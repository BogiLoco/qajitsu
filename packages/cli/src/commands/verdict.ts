import { readdir, readFile, writeFile } from "node:fs/promises";
import { readManifest } from "@qajitsu/adapter-evidence-local";
import {
  APPROVED_PLAN_FILE,
  AuditRecordSchema,
  CanaryRecordSchema,
  CaseResultFileSchema,
  loadApprovedPlan,
  parseEventLines,
  sha256,
  checkJournal,
  journalAnchor,
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
  applyVerificationChecks,
  checkManifest,
  combineGates,
  evaluateRun,
  gateNoSecrets,
  type CaseEvaluation,
  type GateResult,
} from "@qajitsu/verifier";
import { parse } from "yaml";
import type { z } from "zod";
import type { RunSession } from "../session.js";

/** Environment facts recorded in `run.json` by `qj run`. */
export interface RunEnvironment {
  readonly name: string;
  readonly baseUrl: string;
  readonly deployedSha?: string | undefined;
  /** Stubbed services (REQ-ENV-05/AC2). */
  readonly stubs?: readonly string[] | undefined;
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
  /** Auditor and canary notes and downgrades (REQ-VER-06, REQ-VER-09). */
  readonly checks: readonly string[];
}

/**
 * Re-reads results, evidence and the approved plan of a run and computes everything a report or a
 * publication says. Nothing is taken from memory or from earlier reports, so files changed after
 * `qj run` are caught here (hash gates) instead of being published.
 *
 * @param session - Open run session.
 * @param now - Clock for the report date.
 */
export async function computeVerdict(
  session: RunSession,
  now: () => Date,
  options: {
    /** True while the run itself computes statuses before its checks ran (auditor input). */
    readonly checksPending?: boolean;
  } = {},
): Promise<RunVerdict> {
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
  // REQ-VER-06, REQ-VER-09: the auditor and the canary can only move PASSED to NEEDS_REVIEW.
  // Records are hashed into run.json when written; a missing, unreadable or changed record fails
  // closed when the configuration says the check runs and something PASSED.
  const hashes = (ws.record.data["checks"] ?? {}) as Record<string, string | undefined>;
  const anyPassed = evaluated.cases.some((c) => c.status === "PASSED");
  const verification = session.project.config.verification;
  const integrity: string[] = [];
  const readChecked = async <T>(
    name: string,
    schema: z.ZodType<T>,
    expected: boolean,
  ): Promise<T | undefined> => {
    const text = await readFile(ws.path("checks", name), "utf8").catch(() => undefined);
    if (text === undefined) {
      if (expected && anyPassed && options.checksPending !== true)
        integrity.push(`checks/${name} is missing`);
      return undefined;
    }
    if (hashes[name] !== sha256(text)) {
      integrity.push(`checks/${name} does not match the hash recorded in run.json`);
      return undefined;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      integrity.push(`checks/${name} is not valid JSON`);
      return undefined;
    }
    const parsed = schema.safeParse(raw);
    if (!parsed.success) integrity.push(`checks/${name} is not a valid record`);
    return parsed.success ? parsed.data : undefined;
  };
  const audit = await readChecked("audit.json", AuditRecordSchema, verification.auditor !== "off");
  const canary = await readChecked("canary.json", CanaryRecordSchema, verification.canary);
  const checked = applyVerificationChecks(evaluated.cases, audit, canary, integrity);
  const cases = evaluated.cases.map((c, i) => ({ ...c, status: checked[i]?.status ?? c.status }));
  const checkNotes = [
    ...(audit?.status === "done"
      ? [
          `Auditor ${audit.model}: ${String(audit.findings.filter((f) => f.weak).length)} of ${String(audit.findings.length)} PASSED case(s) flagged.${audit.sameModelAsAuthor ? " Warning: the auditor used the author's model (configure models.roles.auditor or a second model)." : ""}`,
        ]
      : audit?.status === "failed"
        ? [`Auditor did not complete (${audit.mode}): ${audit.error}`]
        : []),
    ...integrity.map((p) => `Verification record problem: ${p}`),
    ...(canary?.status === "skipped"
      ? ["Canary skipped: no PASSED case with a structured expectation."]
      : []),
    ...(canary?.status === "error" ? [`Canary could not run: ${canary.detail}`] : []),
    ...(canary?.status === "ran"
      ? [
          canary.caught
            ? `Canary: ${canary.caseId} ${canary.stepId} ${canary.field} failed with an inverted expectation, as it must.`
            : `Canary: ${canary.caseId} ${canary.stepId} ${canary.field} PASSED with an inverted expectation; every PASSED is NEEDS_REVIEW.`,
        ]
      : []),
    ...checked
      .filter((c) => c.downgradedBy)
      .map((c) => `${c.caseId} → NEEDS_REVIEW (${c.downgradedBy ?? ""})`),
  ].map((n) => masker.maskText(n));
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
  const journalText = await readFile(ws.path("journal", "events.jsonl"), "utf8").catch(() => "");
  // REQ-OBS-05: chain intact, journal present, and not shorter than the anchor recorded in run.json.
  const journalCheck = checkJournal(
    journalText,
    ws.record.data["journal"] as { lines: number; tail: string } | undefined,
  );
  const { events } = parseEventLines(journalText);
  const timeline = events
    .filter((e) => !["tool_result", "model.usage"].includes(e.event))
    .map((e) => {
      const d = (e.details ?? {}) as Record<string, unknown>;
      const caseId = typeof d["caseId"] === "string" ? d["caseId"] : undefined;
      const attempt = typeof d["attempt"] === "number" ? d["attempt"] : undefined;
      const step = typeof d["step"] === "string" ? d["step"] : undefined;
      // Canary events are not attempts of the case: no link to the case's evidence.
      const prefix =
        caseId && attempt !== undefined && step && e.stage !== "canary"
          ? `${caseId}/attempt-${String(attempt)}/${step}`
          : undefined;
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
      checks: checkNotes,
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
    { gate: "checks-intact", ok: integrity.length === 0, problems: integrity },
    // REQ-OBS-05: the journal published with the results must be the one that was written.
    {
      gate: "journal-intact",
      ok: journalCheck.problems.length === 0,
      problems: journalCheck.problems.map((p) => `journal/events.jsonl: ${p}`),
    },
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
    checks: checkNotes,
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

/**
 * Records the journal's line count and tail hash in `run.json` at the end of a command (REQ-OBS-05),
 * so a journal cut short or rewritten afterwards fails the `journal-intact` gate.
 */
export async function anchorJournal(session: RunSession): Promise<void> {
  const text = await readFile(session.ws.path("journal", "events.jsonl"), "utf8").catch(() => "");
  await session.ws.update({ data: { ...session.ws.record.data, journal: journalAnchor(text) } });
}
