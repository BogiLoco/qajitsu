import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { runCases, type RunCasesOptions } from "@qajitsu/adapter-runner-api";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import { createUsageTracker, runAuditor, runTriage, type AuditInput } from "@qajitsu/agents";
import {
  AuditRecordSchema,
  CanaryRecordSchema,
  TriageRecordSchema,
  type TriageRecord,
  type AuditRecord,
  type CanaryRecord,
  type CaseResultFile,
  type Plan,
  sha256,
} from "@qajitsu/core";
import { buildCanaryPlan, canaryCaught, checkTriageHints } from "@qajitsu/verifier";
import type { RunSession } from "../session.js";
import { computeVerdict } from "./verdict.js";

const SYSTEM = { kind: "system", name: "orchestrator" } as const;

/** Writes a check record and its SHA-256 into run.json, so a changed or swapped record is caught. */
const writeRecord = async (session: RunSession, name: string, value: unknown): Promise<void> => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(session.ws.path("checks"), { recursive: true });
  await writeFile(session.ws.path("checks", name), text, "utf8");
  const checks = (session.ws.record.data["checks"] ?? {}) as Record<string, string>;
  await session.ws.update({
    data: { ...session.ws.record.data, checks: { ...checks, [name]: sha256(text) } },
  });
};

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
};

/**
 * Runs the independent auditor over the PASSED cases and writes `checks/audit.json` (REQ-VER-06).
 * The record is written by this code from the validated auditor answer; statuses are applied later by
 * `applyVerificationChecks`, which can only downgrade. A failing auditor is recorded, never retried
 * into a better result.
 *
 * @returns The record, or undefined when the auditor is off or nothing PASSED.
 */
export async function auditRun(session: RunSession, now: () => Date): Promise<AuditRecord | undefined> {
  const { project, ws, masker, events } = session;
  const mode = project.config.verification.auditor;
  if (mode === "off") return undefined;
  const verdict = await computeVerdict(session, now, { checksPending: true });
  const passed = verdict.cases.filter((c) => c.status === "PASSED");
  if (passed.length === 0) return undefined;
  const lastEvidence = (r: CaseResultFile | undefined): string[] => r?.attempts.at(-1)?.evidence ?? [];
  const cases: AuditInput["cases"] = verdict.cases.flatMap((c) => {
    const result = verdict.results.get(c.caseId);
    if (!result) return [];
    const paths = new Set(lastEvidence(result));
    return [
      {
        caseId: c.caseId,
        status: c.status,
        result,
        evidence: verdict.manifest
          .filter((m) => paths.has(m.path))
          .map((m) => ({ path: m.path, kind: m.kind, stepId: m.stepId })),
      },
    ];
  });
  const passedPaths = new Set(passed.flatMap((c) => lastEvidence(verdict.results.get(c.caseId))));
  const texts: Record<string, string> = {};
  const images: { name: string; data: Uint8Array; mediaType: string }[] = [];
  for (const m of verdict.manifest.filter((x) => passedPaths.has(x.path))) {
    if (m.kind === "screenshot") {
      if (images.length < project.config.verification.auditor_max_images)
        images.push({
          name: m.path,
          data: await readFile(ws.path("evidence", m.path)),
          mediaType: MEDIA_TYPES[m.path.split(".").at(-1)?.toLowerCase() ?? ""] ?? "image/png",
        });
    } else if (m.kind !== "video" && m.kind !== "trace") {
      texts[m.path] = masker.maskText((await readFile(ws.path("evidence", m.path), "utf8")).slice(0, 4000));
    }
  }
  const usage = createUsageTracker({
    events,
    budget: project.config.models.token_budget,
    alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
  });
  let record: AuditRecord;
  try {
    const result = await runAuditor(
      {
        ws,
        models: session.models,
        events,
        usage,
        now,
        maskJson: (v: unknown) => masker.maskJson(v),
        maskText: (t: string) => masker.maskText(t),
      },
      { plan: verdict.plan, cases, texts, images },
    );
    record = AuditRecordSchema.parse({ schema: 1, status: "done", mode, ...result });
  } catch (error) {
    record = {
      schema: 1,
      status: "failed",
      mode,
      error: masker.maskText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
    events.emit("audit", SYSTEM, "audit.failed", { mode, error: record.error });
  }
  await ws.update({ data: { ...ws.record.data, tokens: usage.total } });
  await writeRecord(session, "audit.json", record);
  return record;
}

/**
 * Runs the canary (REQ-VER-09): the first case that PASSED is executed once more with one expectation
 * inverted in a copy of the plan. A working test must fail it. Evidence and results of the canary stay
 * under `checks/canary/`, outside the manifest and the published results.
 *
 * @param base - The run's `runCases` options (executor, login, URLs, events).
 * @returns The record: `ran`, `skipped` when nothing qualifies, or `error` (not caught) when it could not run.
 */
export async function runCanary(
  session: RunSession,
  plan: Plan,
  ran: ReadonlyMap<string, CaseResultFile>,
  specs: ReadonlyMap<string, string>,
  base: Omit<RunCasesOptions, "plan" | "specs" | "evidence" | "resultsDir" | "retries" | "workers" | "heal">,
): Promise<CanaryRecord> {
  const candidate = plan.cases.find((c) => {
    const last = ran.get(c.id)?.attempts.at(-1);
    return (
      last?.outcome === "passed" && last.healed !== true && specs.has(c.id) && buildCanaryPlan(plan, c.id)
    );
  });
  const canary = candidate ? buildCanaryPlan(plan, candidate.id) : undefined;
  const spec = canary ? specs.get(canary.caseId) : undefined;
  let record: CanaryRecord;
  if (!canary || spec === undefined) {
    record = {
      schema: 1,
      status: "skipped",
      caseId: "-",
      stepId: "-",
      field: "-",
      caught: false,
      detail: "no PASSED case with a structured expectation",
    };
  } else {
    // Canary events are tagged and kept out of the case timeline (they are not the case's attempts).
    const events = {
      emit: (
        _stage: string,
        actor: Parameters<typeof base.events.emit>[1],
        event: string,
        details?: unknown,
      ) => {
        base.events.emit("canary", actor, event, { ...(details as object | undefined), canary: true });
      },
    };
    events.emit("run", SYSTEM, "canary.start", {
      caseId: canary.caseId,
      step: canary.stepId,
      field: canary.field,
    });
    const dir = session.ws.path("checks", "canary");
    try {
      const results = await runCases({
        ...base,
        events,
        plan: { ...canary.plan, cases: canary.plan.cases.filter((c) => c.id === canary.caseId) },
        specs: new Map([[canary.caseId, spec]]),
        evidence: createLocalEvidenceStore(`${dir}/evidence`),
        resultsDir: `${dir}/results`,
        retries: 0,
        workers: 1,
      });
      const last = results.get(canary.caseId)?.attempts.at(-1);
      const caught = canaryCaught(canary, last?.assertions ?? []);
      record = {
        schema: 1,
        status: "ran",
        caseId: canary.caseId,
        stepId: canary.stepId,
        field: canary.field,
        caught,
        detail: session.masker.maskText(
          caught
            ? "the inverted expectation failed"
            : `the inverted expectation was not caught (attempt ${last?.outcome ?? "missing"})`,
        ),
      };
    } catch (error) {
      record = {
        schema: 1,
        status: "error",
        caseId: canary.caseId,
        stepId: canary.stepId,
        field: canary.field,
        caught: false,
        detail: session.masker.maskText(error instanceof Error ? error.message : String(error)).slice(0, 300),
      };
    }
    events.emit("run", SYSTEM, "canary.end", { status: record.status, caught: record.caught });
  }
  record = CanaryRecordSchema.parse(record);
  await writeRecord(session, "canary.json", record);
  return record;
}

/** Log files of a run (relative to `logs/`), newest content last; at most `max`. */
async function runLogs(dir: string, max: number): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => []);
  return entries
    .filter((e) => e.isFile() && /\.(log|txt|jsonl?)$/i.test(e.name))
    .map((e) => relative(dir, join(e.parentPath, e.name)).split(sep).join("/"))
    .sort()
    .slice(0, max);
}

/**
 * Suggests a cause for every FAILED case (REQ-VER-12) and writes `checks/triage.json`. Hints are kept only when
 * their citations exist (`checkTriageHints`); a model failure is recorded and the run continues without hints
 * (AC4). Statuses never read this record (invariant 1).
 *
 * @returns The record, or undefined when triage is off or nothing FAILED.
 */
export async function triageRun(session: RunSession, now: () => Date): Promise<TriageRecord | undefined> {
  const { project, ws, masker, events } = session;
  if (project.config.verification.triage === "off") return undefined;
  const verdict = await computeVerdict(session, now);
  const failed = verdict.cases.filter((c) => c.status === "FAILED").map((c) => c.caseId);
  if (failed.length === 0) return undefined;
  const cases = failed.flatMap((caseId) => {
    const result = verdict.results.get(caseId);
    return result ? [{ caseId, result, evidence: result.attempts.at(-1)?.evidence ?? [] }] : [];
  });
  const texts: Record<string, string> = {};
  for (const m of verdict.manifest)
    if (cases.some((c) => c.evidence.includes(m.path)) && !["screenshot", "video", "trace"].includes(m.kind))
      texts[m.path] = masker.maskText((await readFile(ws.path("evidence", m.path), "utf8")).slice(0, 4000));
  const logNames = await runLogs(ws.path("logs"), 10);
  const logs: Record<string, string> = {};
  for (const name of logNames)
    logs[name] = masker.maskText(
      (await readFile(ws.path("logs", name), "utf8").catch(() => "")).slice(-3000),
    );
  const usage = createUsageTracker({
    events,
    budget: project.config.models.token_budget,
    alreadyUsed: Number(ws.record.data["tokens"] ?? 0),
  });
  let record: TriageRecord;
  try {
    const answer = await runTriage(
      {
        ws,
        models: session.models,
        events,
        usage,
        now,
        maskJson: (v: unknown) => masker.maskJson(v),
        maskText: (t: string) => masker.maskText(t),
      },
      { plan: verdict.plan, cases, texts, logs },
    );
    const checked = checkTriageHints(
      answer.hints.map((h) => ({ ...h, justification: masker.maskText(h.justification) })),
      { results: verdict.results, manifest: verdict.manifest.map((m) => m.path), logs: logNames, failed },
    );
    record = TriageRecordSchema.parse({ schema: 1, status: "done", model: answer.model, ...checked });
  } catch (error) {
    record = {
      schema: 1,
      status: "failed",
      error: masker.maskText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
    events.emit("triage", SYSTEM, "triage.failed", { error: record.error });
  }
  await ws.update({ data: { ...ws.record.data, tokens: usage.total } });
  await writeRecord(session, "triage.json", record);
  return record;
}
