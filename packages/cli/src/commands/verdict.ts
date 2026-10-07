import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readManifest } from "@qajitsu/adapter-evidence-local";
import {
  APPROVED_PLAN_FILE,
  AuditRecordSchema,
  CanaryRecordSchema,
  TriageRecordSchema,
  CaseResultFileSchema,
  loadApprovedPlan,
  parseEventLines,
  sha256,
  checkJournal,
  journalAnchor,
  OBSERVATIONS_FILE,
  webCombinations,
  type CaseResultFile,
  type TestStatus,
  type RunObservation,
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
  collectObservations,
  renderMatrixCsv,
  renderMatrixMarkdown,
  renderMatrixXlsx,
  renderJUnit,
  renderReportHtml,
  type MatrixRow,
  type ReportAttempt,
} from "@qajitsu/report";
import {
  applyVerificationChecks,
  checkManifest,
  combineGates,
  combineStatuses,
  evaluateCases,
  evaluateRun,
  gateNoSecrets,
  type CaseEvaluation,
  type GateResult,
} from "@qajitsu/verifier";
import { parse } from "yaml";
import { z } from "zod";
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
  /** JUnit XML for pipelines (REQ-CI-04/AC2), masked. */
  readonly junit: string;
  /** Passive observations (REQ-EVD-07), masked; never part of a status or a count. */
  readonly observations: readonly RunObservation[];
  /** Fix verification lines for the Jira comment (REQ-VER-11/AC4); empty without `--fix-check`. */
  readonly fixCheck: readonly string[];
}

/** `data.fixCheck` of `run.json`, written by `qj run --fix-check` (REQ-VER-11). */
const FixCheckDataSchema = z.object({
  verified: z.boolean(),
  baseRun: z.string(),
  repo: z.string(),
  baseSha: z.string(),
  fixSha: z.string(),
  cases: z.array(
    z.object({
      caseId: z.string(),
      before: z.string(),
      after: z.string(),
      specAfter: z.string(),
      verified: z.boolean(),
      reason: z.string(),
    }),
  ),
});

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
  // REQ-EXEC-13: every further browser and viewport combination is evaluated by the same code; a case is PASSED
  // only when every combination it ran in passed.
  const combos = webCombinations(session.project.config.web);
  const perCombination = new Map<string, { combo: string; status: TestStatus }[]>();
  const matrixResults: { name: string; text: string }[] = [];
  for (const combo of combos.slice(1)) {
    const dir = ws.path("results", "matrix", combo.id);
    const comboResults = new Map<string, CaseResultFile>();
    for (const file of (await readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith(".json"))) {
      const text = await readFile(join(dir, file), "utf8");
      const parsed = CaseResultFileSchema.safeParse(JSON.parse(text) as unknown);
      if (parsed.success && parsed.data.caseId === file.slice(0, -5)) {
        comboResults.set(parsed.data.caseId, parsed.data);
        matrixResults.push({ name: `results/matrix/${combo.id}/${file}`, text });
      } else malformed.push(`results/matrix/${combo.id}/${file}: not a valid results file`);
    }
    for (const c of evaluateCases(plan, comboResults, manifest, manifestCheck))
      if (comboResults.has(c.caseId))
        perCombination.set(c.caseId, [
          ...(perCombination.get(c.caseId) ?? []),
          { combo: combo.id, status: c.status },
        ]);
  }
  const combined = evaluated.cases.map((c) => {
    const others = perCombination.get(c.caseId);
    return others ? { ...c, status: combineStatuses([c.status, ...others.map((o) => o.status)]) } : c;
  });
  const combinationsOf = (caseId: string, primaryStatus: TestStatus): string | undefined => {
    const others = perCombination.get(caseId);
    return others && combos[0]
      ? [`${combos[0].id} ${primaryStatus}`, ...others.map((o) => `${o.combo} ${o.status}`)].join(", ")
      : undefined;
  };
  // REQ-VER-06, REQ-VER-09: the auditor and the canary can only move PASSED to NEEDS_REVIEW.
  // Records are hashed into run.json when written; a missing, unreadable or changed record fails
  // closed when the configuration says the check runs and something PASSED.
  const hashes = (ws.record.data["checks"] ?? {}) as Record<string, string | undefined>;
  const anyPassed = combined.some((c) => c.status === "PASSED");
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
  // REQ-VER-12: hints are shown next to the results and never read by status computation (invariant 1).
  const triage = await readChecked("triage.json", TriageRecordSchema, false);
  const hintOf = new Map(
    (triage?.status === "done" ? triage.hints : []).map((h) => [
      h.caseId,
      masker.maskText(`${h.category}: ${h.justification}`),
    ]),
  );
  const checked = applyVerificationChecks(combined, audit, canary, integrity);
  const cases = combined.map((c, i) => ({ ...c, status: checked[i]?.status ?? c.status }));
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
    ...(triage?.status === "done" && triage.hints.length > 0
      ? [`Failure hints by ${triage.model}: suggestions with cited evidence, not statuses.`]
      : []),
    ...(triage?.status === "failed" ? [`Failure hints not available: ${triage.error}`] : []),
    ...checked
      .filter((c) => c.downgradedBy)
      .map((c) => `${c.caseId} → NEEDS_REVIEW (${c.downgradedBy ?? ""})`),
  ].map((n) => masker.maskText(n));
  // REQ-EXEC-11/AC6: which steps a person performed, from the runner's record of the last attempt.
  const manualOf = (caseId: string): { manual?: string } => {
    const done = (results.get(caseId)?.attempts.at(-1)?.assertions ?? []).filter(
      (a) => a.source === "manual",
    );
    return done.length === 0
      ? {}
      : {
          manual: masker.maskText(
            done.map((a) => `${a.stepId} ${String(a.actual)} by ${a.by ?? "?"}`).join(", "),
          ),
        };
  };
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
      ...(c.status === "FAILED" && hintOf.has(c.caseId) ? { hint: hintOf.get(c.caseId) } : {}),
      ...manualOf(c.caseId),
      ...(() => {
        const primaryStatus = evaluated.cases.find((e) => e.caseId === c.caseId)?.status ?? c.status;
        const combinations = combinationsOf(c.caseId, primaryStatus);
        return combinations ? { combinations } : {};
      })(),
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
  // REQ-EVD-07: observations from the last attempt of every case, computed by code, filtered by the config.
  const observations = collectObservations(
    [...results.values()].map((r) => {
      const last = r.attempts.at(-1);
      const file = manifest.find(
        (m) => last?.evidence.includes(m.path) === true && m.path.endsWith(`/${OBSERVATIONS_FILE}`),
      );
      return {
        caseId: r.caseId,
        assertions: last?.assertions ?? [],
        observationsFile: file ? evidenceText.get(file.path) : undefined,
      };
    }),
    session.project.config.observations.ignore,
  ).map((o) => ({ ...o, text: masker.maskText(o.text) }));
  const fixCheckData = FixCheckDataSchema.safeParse(ws.record.data["fixCheck"]);
  const fixCheck = fixCheckData.success ? fixCheckData.data : undefined;
  const fixCheckLines = fixCheck
    ? [
        `Fix ${fixCheck.verified ? "verified" : "NOT verified"}: before ${fixCheck.repo}@${fixCheck.baseSha.slice(0, 12)} (run ${fixCheck.baseRun}), with the fix ${fixCheck.fixSha.slice(0, 12)}`,
        ...fixCheck.cases.map(
          (c) => `${c.caseId}: ${c.before} before, ${c.after} with the fix (${c.reason})`,
        ),
        `Evidence before the fix: qajitsu evidence ${ws.ticket} --run ${fixCheck.baseRun}`,
      ]
    : [];
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
      observations,
      fixCheck,
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
      ...matrixResults,
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
    observations,
    fixCheck: fixCheckLines,
    junit: masker.maskText(
      renderJUnit(
        { ticket: ws.ticket, runId: ws.runId },
        cases.map((c) => {
          const p = plan.cases.find((x) => x.id === c.caseId);
          return {
            caseId: c.caseId,
            title: p?.title ?? c.caseId,
            type: p?.type ?? "api",
            status: c.status,
            durationMs: results.get(c.caseId)?.attempts.reduce((n, a) => n + (a.durationMs ?? 0), 0),
            // Masked before XML escaping: an escaped secret (&amp;, &quot;) would no longer match the masker.
            failures: c.failures.map((f) => ({
              ...f,
              expected: masker.maskJson(f.expected),
              actual: masker.maskJson(f.actual),
            })),
            error: c.error === undefined ? undefined : masker.maskText(c.error),
            reportPath: "report/report.html",
          };
        }),
      ),
    ),
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
  await writeFile(ws.path("report", "junit.xml"), v.junit, "utf8");
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
