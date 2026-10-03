import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { checkHealth, compareDeployedSha, loginAccounts, readDeployedSha } from "@qajitsu/adapter-env-remote";
import { createLocalEvidenceStore, readManifest } from "@qajitsu/adapter-evidence-local";
import {
  createSandboxExecutor,
  loadContractValidator,
  runCases,
  type AttemptExecutor,
  type ContractValidator,
} from "@qajitsu/adapter-runner-api";
import { buildChangeContext, checkSpec, createUsageTracker, runAuthor } from "@qajitsu/agents";
import {
  APPROVED_PLAN_FILE,
  AnalysisSchema,
  ConfigError,
  CaseResultFileSchema,
  QajitsuError,
  exitCodeFor,
  loadApprovedPlan,
  resolveEnvironment,
  selectExecutableSpecs,
  sha256,
  type CaseResultFile,
  type Plan,
  type ResolvedEnvironment,
} from "@qajitsu/core";
import {
  renderMatrixCsv,
  renderMatrixMarkdown,
  renderMatrixXlsx,
  renderReportHtml,
  chooseSummary,
  type MatrixRow,
  type ReportAttempt,
} from "@qajitsu/report";
import { createMasker } from "@qajitsu/steps";
import {
  checkManifest,
  combineGates,
  evaluateRun,
  gateNoSecrets,
  formatSpecProblems,
} from "@qajitsu/verifier";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** Options of `qajitsu run`. */
export interface RunOptions {
  readonly run?: string | undefined;
  readonly env?: string | undefined;
}

/** Ports `run` needs beyond the common ones; the executor is replaceable in tests. */
export interface RunPorts {
  readonly executor?: AttemptExecutor;
}

const RUNNER = { kind: "runner", name: "api" } as const;
const SYSTEM = { kind: "system", name: "orchestrator" } as const;

const blockedResult = (caseId: string, reason: string): CaseResultFile =>
  CaseResultFileSchema.parse({
    schema: 1,
    caseId,
    runner: "api",
    attempts: [{ attempt: 1, outcome: "error", assertions: [], error: reason, steps: [], evidence: [] }],
  });

async function writeBlocked(
  session: RunSession,
  caseIds: readonly string[],
  reason: string,
  results: Map<string, CaseResultFile>,
): Promise<void> {
  for (const id of caseIds) {
    const result = blockedResult(id, reason);
    await writeFile(session.ws.path("results", `${id}.json`), `${JSON.stringify(result, null, 2)}\n`, {
      flag: "wx",
    });
    results.set(id, result);
  }
}

async function chooseEnvironment(
  session: RunSession,
  io: CommandIO,
  env: string | undefined,
): Promise<ResolvedEnvironment> {
  try {
    return await resolveEnvironment({ config: session.project.config, qaDir: session.project.qaDir, env });
  } catch (error) {
    // REQ-ENV-07/AC2: without a default, interactive runs ask; CI fails with the configuration error.
    if (error instanceof ConfigError && error.code === "ENV_NOT_SELECTED" && io.ask) {
      const answer = (await io.ask("Environment profile or URL: ")).trim();
      if (answer !== "")
        return resolveEnvironment({
          config: session.project.config,
          qaDir: session.project.qaDir,
          env: answer,
        });
    }
    throw error;
  }
}

/**
 * `qajitsu run <TICKET> [--env <profile|url>]`: executes the approved plan against a provided
 * environment and writes results, evidence and reports (roadmap stage 3).
 *
 * @returns Exit code from statuses (0 all passed, 1 any failed, 2 otherwise) or 3 on errors (REQ-CI-04).
 */
export async function runRun(
  rawKey: string,
  options: RunOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, events, project } = session;
    if (ws.record.data["results"] !== undefined) {
      throw new ConfigError(
        "RUN_ALREADY_EXECUTED",
        "This run already has results; start a new run to test again.",
        {},
      );
    }
    const { plan, approval } = await loadApprovedPlan(ws);
    events.emit("run", SYSTEM, "stage.start", { planVersion: approval.version });
    const results = new Map<string, CaseResultFile>();

    const env = await chooseEnvironment(session, io, options.env);
    const health = await checkHealth(env, ports.fetch);
    events.emit("run", SYSTEM, "env.health", { env: env.name, ok: health.ok, detail: health.detail });
    const deployedSha = health.ok ? await readDeployedSha(env, ports.fetch) : undefined;
    const analysed = Object.values(ws.record.repos).map((r) => r.sha);
    const versionCheck = compareDeployedSha(deployedSha, analysed);
    await ws.update({
      status: "running",
      stage: "run",
      data: {
        ...ws.record.data,
        environment: { name: env.name, baseUrl: env.baseUrl, deployedSha, versionCheck },
      },
    });

    if (!health.ok) {
      // REQ-ENV-01/AC1: an unreachable environment makes every case BLOCKED.
      io.writeError(`Environment ${env.name} is not healthy (${health.detail}); every case is BLOCKED.\n`);
      await writeBlocked(
        session,
        plan.cases.map((c) => c.id),
        `environment not healthy: ${health.detail}`,
        results,
      );
    } else {
      if (versionCheck === "mismatch") {
        const message = `Environment runs ${String(deployedSha)}, the change is ${analysed.map((s) => s.slice(0, 12)).join(", ")}.`;
        events.emit("run", SYSTEM, "env.version_mismatch", { deployedSha, analysed });
        if (io.ask) {
          const answer = (await io.ask(`${message} Test anyway? [y/N] `)).trim().toLowerCase();
          events.emit("run", { kind: "user", name: "cli" }, "env.version_confirmed", { answer });
          if (answer !== "y" && answer !== "yes")
            throw new ConfigError("ENV_VERSION_MISMATCH", `${message} Aborted.`, {});
        } else if (project.config.environments.on_version_mismatch === "fail") {
          throw new ConfigError("ENV_VERSION_MISMATCH", message, { deployedSha });
        } else {
          io.writeError(`Warning: ${message}\n`);
        }
      }
      const pending = await executeCases(session, plan, env, io, ports, results);
      if (pending.length > 0)
        io.write(`Rejected spec files (not in the approved plan or misplaced): ${pending.join(", ")}\n`);
    }

    // Statuses, gates and reports: computed by code only (invariants 1, 6, 7).
    const manifest = await readManifest(ws.path("evidence"));
    const manifestCheck = await checkManifest(ws.path("evidence"), manifest);
    const reported = (await readdir(ws.path("results")))
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.slice(0, -5));
    const currentSha = sha256(await readFile(ws.path("plan", APPROVED_PLAN_FILE), "utf8"));
    const { cases, gates } = evaluateRun({
      plan,
      results,
      reportedCaseIds: reported,
      manifest,
      manifestCheck,
      approvedSha256: approval.sha256,
      currentSha256: currentSha,
    });
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
    const summary = chooseSummary(undefined, rows);
    const attempts: Record<string, ReportAttempt[]> = {};
    for (const [id, r] of results) {
      attempts[id] = await Promise.all(
        r.attempts.map(async (a) => ({
          attempt: a.attempt,
          outcome: a.outcome,
          error: a.error,
          assertions: a.assertions,
          evidence: await Promise.all(
            manifest
              .filter((m) => a.evidence.includes(m.path))
              .map(async (m) => ({
                path: m.path,
                sha256: m.sha256,
                kind: m.kind,
                stepId: m.stepId,
                text: masker.maskText(await readFile(ws.path("evidence", m.path), "utf8")),
              })),
          ),
        })),
      );
    }
    const matrixMd = renderMatrixMarkdown(rows);
    const csv = renderMatrixCsv(rows);
    const draftHtml = (g: typeof gates) =>
      renderReportHtml({
        ticket: ws.ticket,
        summary: summary.text,
        runId: ws.runId,
        generatedAt: ports.now().toISOString(),
        plan,
        planSha256: approval.sha256,
        rows,
        attempts,
        environment: { name: env.name, baseUrl: env.baseUrl, deployedSha },
        repos: Object.fromEntries(Object.entries(ws.record.repos).map(([k, v]) => [k, v.sha])),
        gates: g,
      });
    const secretGate = gateNoSecrets(
      [
        { name: "matrix.md", text: matrixMd },
        { name: "matrix.csv", text: csv },
        { name: "report.html", text: draftHtml(gates) },
        // Evidence and results leave the machine with the report (REQ-PUB-02), so they are scanned too.
        ...(await Promise.all(
          manifest.map(async (m) => ({
            name: `evidence/${m.path}`,
            text: await readFile(ws.path("evidence", m.path), "utf8").catch(() => ""),
          })),
        )),
        ...(await Promise.all(
          reported.map(async (id) => ({
            name: `results/${id}.json`,
            text: await readFile(ws.path("results", `${id}.json`), "utf8"),
          })),
        )),
      ],
      (t) => masker.containsSecret(t),
    );
    const allGates = [...gates, secretGate];
    const verdict = combineGates(allGates);
    await writeFile(ws.path("report", "matrix.md"), matrixMd, "utf8");
    await writeFile(ws.path("report", "matrix.csv"), csv, "utf8");
    await writeFile(ws.path("report", "matrix.xlsx"), renderMatrixXlsx(rows));
    await writeFile(ws.path("report", "report.html"), masker.maskText(draftHtml(allGates)), "utf8");
    await writeFile(
      ws.path("report", "gates.json"),
      `${JSON.stringify({ ok: verdict.ok, gates: allGates }, null, 2)}\n`,
      "utf8",
    );
    const statuses = Object.fromEntries(cases.map((c) => [c.caseId, c.status]));
    await ws.update({
      status: "completed",
      stage: "run",
      data: { ...ws.record.data, results: statuses, gatesOk: verdict.ok },
      checkpoints: [...ws.record.checkpoints, { stage: "run", at: ports.now().toISOString() }],
    });
    events.emit("run", SYSTEM, "stage.end", { statuses, gatesOk: verdict.ok });

    io.write(`${matrixMd}\n`);
    io.write(`Report: ${ws.path("report", "report.html")}\n`);
    if (!verdict.ok) {
      io.writeError(
        `Publish gates failed; results must not be published:\n${verdict.failed.map((g) => `  ✘ ${g.gate}: ${g.problems.join("; ")}`).join("\n")}\n`,
      );
    }
    const code = exitCodeFor(cases.map((c) => c.status));
    return !verdict.ok && code === 0 ? 2 : code;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}

/**
 * Authors missing specs, checks every spec, executes the approved ones and fills `results`.
 *
 * @returns Spec files that were rejected (not in the plan or misplaced).
 */
async function executeCases(
  session: RunSession,
  plan: Plan,
  env: ResolvedEnvironment,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
  results: Map<string, CaseResultFile>,
): Promise<string[]> {
  const { ws, events, project, masker } = session;
  const specsDir = ws.path("specs");
  const existing = new Set(
    (await readdir(specsDir))
      .map((f) => /^(TC-\d{2,4})\.spec\.ts$/.exec(f)?.[1])
      .filter((x): x is string => x !== undefined),
  );
  const missing = plan.cases.filter((c) => !existing.has(c.id));
  const blocked = new Map<string, string>();
  if (missing.length > 0) {
    io.write(`Writing specs for ${missing.map((c) => c.id).join(", ")}…\n`);
    const analysis = AnalysisSchema.parse(JSON.parse(await readFile(ws.path("analysis.json"), "utf8")));
    const usage = createUsageTracker({
      events,
      budget: project.config.models.token_budget,
      alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
    });
    const deps = {
      ws,
      models: session.models,
      events,
      usage,
      now: ports.now,
      maskJson: (v: unknown) => masker.maskJson(v),
      maskText: (t: string) => masker.maskText(t),
    };
    const authored = await runAuthor(
      deps,
      { ...plan, cases: missing },
      await buildChangeContext(ws),
      analysis,
      Object.keys(env.profile.accounts),
    );
    await ws.update({ data: { ...ws.record.data, tokens: usage.total } });
    for (const a of authored)
      if (!a.file)
        blocked.set(a.caseId, `author could not produce a valid spec: ${formatSpecProblems(a.problems)}`);
  }
  // Every spec is checked before execution, also hand-written ones (REQ-EXEC-03).
  const files = (await readdir(specsDir)).map((f) => join(specsDir, f));
  const { execute, rejected } = selectExecutableSpecs(plan, files, specsDir);
  for (const file of rejected)
    events.emit("run", SYSTEM, "spec.rejected", { file: file.slice(ws.dir.length + 1) });
  const specs = new Map<string, string>();
  for (const file of execute) {
    const caseId = /(TC-\d{2,4})\.spec\.ts$/.exec(file)?.[1] ?? "";
    const problems = await checkSpec(await readFile(file, "utf8"), caseId, plan);
    if (problems.length > 0)
      blocked.set(caseId, `spec failed static checks: ${formatSpecProblems(problems)}`);
    else specs.set(caseId, file);
  }
  for (const [caseId, reason] of blocked) {
    events.emit("run", SYSTEM, "case.blocked", { caseId, reason: reason.slice(0, 500) });
    await writeBlocked(session, [caseId], reason, results);
  }
  const executor = ports.executor ?? createSandboxExecutor();
  // The contract is read from the worktree, i.e. from exactly the analysed version of the code.
  let contract: ContractValidator | undefined;
  for (const [alias, repo] of Object.entries(project.config.repos)) {
    if (repo.openapi === undefined || ws.record.repos[alias] === undefined) continue;
    contract = await loadContractValidator(ws.path("repos", alias, repo.openapi));
    events.emit("run", SYSTEM, "contract.loaded", { repo: alias, file: repo.openapi });
    break;
  }
  const ran = await runCases({
    plan: { ...plan, cases: plan.cases.filter((c) => !blocked.has(c.id)) },
    specs,
    executor,
    evidence: createLocalEvidenceStore(ws.path("evidence")),
    resultsDir: ws.path("results"),
    baseUrl: env.baseUrl,
    allowedOrigins: [env.origin],
    login: () =>
      loginAccounts(env, {
        fetch: ports.fetch,
        resolveSecret: (r) => session.resolveSecret(r),
        registerSecret: (v) => {
          masker.register(v);
        },
      }),
    retries: project.config.environments.retries,
    contract,
    events,
    now: ports.now,
  });
  for (const [id, r] of ran) results.set(id, r);
  events.emit("run", RUNNER, "cases.done", { cases: ran.size });
  return rejected.map((f) => f.slice(ws.dir.length + 1));
}
