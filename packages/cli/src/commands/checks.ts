import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { runUsage, saveRunUsage } from "../run-usage.js";
import { join, relative, sep } from "node:path";
import type * as RunnerApiPlugin from "@qajitsu/adapter-runner-api";
import type { RunCasesOptions } from "@qajitsu/adapter-runner-api";
import { sessionPlugins } from "./plugin.js";
import { createLocalEvidenceStore } from "@qajitsu/adapter-evidence-local";
import {
  collectAudit,
  queueAudit,
  runAuditor,
  runBlockedHints,
  runTriage,
  type AuditInput,
} from "@qajitsu/agents";
import {
  AuditRecordSchema,
  CanaryRecordSchema,
  ConfigError,
  acquireRunLock,
  parseEventLines,
  TriageRecordSchema,
  BlockedRecordSchema,
  type BlockedRecord,
  type TriageRecord,
  type AuditRecord,
  type CanaryRecord,
  type CaseResultFile,
  type Plan,
  sha256,
} from "@qajitsu/core";
import { buildCanaryPlan, canaryCaught, checkBlockedHints, checkTriageHints } from "@qajitsu/verifier";
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
 * Queues the audit in the auditor provider's batch (REQ-VER-06/AC4): the request goes to `checks/audit-request.json`
 * (masked, its hash in run.json), the queued record names the batch. Undefined when the provider has no batch API.
 * A failure to queue is a failed audit, recorded like any other.
 */
async function queuedAuditRecord(
  session: RunSession,
  deps: Parameters<typeof queueAudit>[0],
  input: AuditInput,
  mode: "optional" | "required",
  now: () => Date,
): Promise<AuditRecord | undefined> {
  let queued;
  try {
    queued = await queueAudit(deps, input);
  } catch (error) {
    const message = session.masker
      .maskText(error instanceof Error ? error.message : String(error))
      .slice(0, 500);
    session.events.emit("audit", SYSTEM, "audit.failed", { mode, error: message });
    return { schema: 1, status: "failed", mode, error: message };
  }
  if (!queued) {
    session.events.emit("audit", SYSTEM, "audit.batch_unavailable", {
      reason: "the auditor's provider has no batch API; audited now",
    });
    return undefined;
  }
  const request = session.masker.maskJson(queued.request);
  await writeRecord(session, AUDIT_REQUEST, request);
  return AuditRecordSchema.parse({
    schema: 1,
    status: "queued",
    mode,
    model: queued.model,
    sameModelAsAuthor: queued.sameModelAsAuthor,
    passed: queued.passed,
    batch: queued.batch,
    submittedAt: now().toISOString(),
    ...(queued.expiresAt ? { expiresAt: queued.expiresAt } : {}),
    requestSha256: sha256(JSON.stringify(request)),
    resultsSha256: await resultsDigest(session.ws),
  });
}

/** The request of a queued audit, kept until it is collected (REQ-VER-06/AC4). */
const AUDIT_REQUEST = "audit-request.json";

/**
 * A digest over the run's result files and evidence manifest (REQ-VER-06/AC4): what a queued audit reviewed. A rerun
 * of the cases changes it, so an answer about the earlier results is never applied to the new ones.
 */
async function resultsDigest(ws: RunSession["ws"]): Promise<string> {
  const names = (await readdir(ws.path("results")).catch(() => [] as string[]))
    .filter((n) => n.endsWith(".json"))
    .sort();
  const parts: string[] = [];
  for (const n of names) parts.push(`results/${n} ${sha256(await readFile(ws.path("results", n)))}`);
  const manifest = await readFile(ws.path("evidence", "manifest.json")).catch(() => undefined);
  parts.push(`evidence/manifest.json ${manifest === undefined ? "-" : sha256(manifest)}`);
  return sha256(parts.join("\n"));
}

/** Removes a check record and its hash (only the orchestrator, while it writes the record anew). */
async function dropRecord(session: RunSession, name: string): Promise<void> {
  await rm(session.ws.path("checks", name), { force: true });
  const checks = Object.fromEntries(
    Object.entries((session.ws.record.data["checks"] ?? {}) as Record<string, string>).filter(
      ([k]) => k !== name,
    ),
  );
  await session.ws.update({ data: { ...session.ws.record.data, checks } });
}

/**
 * Collects the run's queued audit (REQ-VER-06/AC4): while the batch is pending nothing changes; its answer, checked
 * like an immediate audit's, or its failure replaces the queued record. The stored request must be the one queued.
 *
 * @returns `undefined` when the run has no queued audit; `pending` with the progress; the new record otherwise.
 * @throws ConfigError `AUDIT_REQUEST_CHANGED` when the stored request or the queued record was changed.
 */
export async function collectQueuedAudit(
  session: RunSession,
  now: () => Date,
): Promise<
  | undefined
  | { readonly status: "pending"; readonly counts?: { readonly completed: number; readonly total: number } }
  | { readonly status: "collected"; readonly record: AuditRecord }
> {
  const { ws, masker, events } = session;
  const checks = (ws.record.data["checks"] ?? {}) as Record<string, string>;
  const read = async (name: string): Promise<string | undefined> => {
    const text = await readFile(ws.path("checks", name), "utf8").catch(() => undefined);
    if (text !== undefined && checks[name] !== sha256(text))
      throw new ConfigError(
        "AUDIT_REQUEST_CHANGED",
        `checks/${name} does not match the hash recorded in run.json; the queued audit cannot be trusted.`,
        { file: name },
      );
    return text;
  };
  // A missing, changed or broken audit record is not collected: the verdict's record checks fail closed on it.
  const auditText = await readFile(ws.path("checks", "audit.json"), "utf8").catch(() => undefined);
  if (auditText === undefined || checks["audit.json"] !== sha256(auditText)) return undefined;
  let parsedAudit: unknown;
  try {
    parsedAudit = JSON.parse(auditText);
  } catch {
    return undefined;
  }
  const valid = AuditRecordSchema.safeParse(parsedAudit);
  if (!valid.success || valid.data.status !== "queued") return undefined;
  const audit = valid.data;
  const requestText = await read(AUDIT_REQUEST);
  const request: unknown = requestText === undefined ? undefined : JSON.parse(requestText);
  if (request === undefined || sha256(JSON.stringify(request)) !== audit.requestSha256)
    throw new ConfigError(
      "AUDIT_REQUEST_CHANGED",
      "checks/audit-request.json is not the request that was queued; the queued audit cannot be trusted.",
      {},
    );
  // The results it reviewed must still be the run's: a rerun voids it, as a required audit that failed.
  if ((await resultsDigest(ws)) !== audit.resultsSha256) {
    const record: AuditRecord = {
      schema: 1,
      status: "failed",
      mode: "required",
      error: `the results changed after the audit was queued in batch ${audit.batch.id}; audit the run again`,
    };
    events.emit("audit", SYSTEM, "audit.failed", {
      mode: "required",
      error: record.error,
      batch: audit.batch.id,
    });
    await writeRecord(session, "audit.json", record);
    return { status: "collected", record };
  }
  // One collector at a time: the call is recorded once, the record written once.
  const release = await acquireRunLock(ws.path("run.lock"));
  try {
    const journal = await readFile(ws.path("journal", "events.jsonl"), "utf8").catch(() => "");
    const alreadyRecorded = parseEventLines(journal).events.some(
      (e) =>
        e.event === "audit.batch_recorded" &&
        (e.details as { batch?: unknown } | undefined)?.batch === audit.batch.id,
    );
    const usage = runUsage(session);
    const collected = await collectAudit(
      {
        ws,
        models: session.models,
        events,
        usage,
        now,
        maskJson: (v: unknown) => masker.maskJson(v),
        maskText: (t: string) => masker.maskText(t),
      },
      {
        model: audit.model,
        sameModelAsAuthor: audit.sameModelAsAuthor,
        passed: audit.passed,
        batch: audit.batch,
        ...(audit.expiresAt ? { expiresAt: audit.expiresAt } : {}),
        request,
        requestSha256: audit.requestSha256,
      },
      { alreadyRecorded },
    );
    if (collected.status === "pending") return collected;
    const record: AuditRecord =
      collected.status === "done"
        ? AuditRecordSchema.parse({ schema: 1, status: "done", mode: audit.mode, ...collected.result })
        : {
            schema: 1,
            status: "failed",
            // An answer that is not a valid report could hide a weak finding: it fails like a required audit.
            mode: collected.invalidAnswer === true ? "required" : audit.mode,
            error: masker.maskText(collected.error).slice(0, 500),
          };
    events.emit(
      "audit",
      SYSTEM,
      record.status === "done" ? "audit.done" : "audit.failed",
      record.status === "done"
        ? {
            cases: record.findings.length,
            weak: record.findings.filter((f) => f.weak).length,
            batch: audit.batch.id,
          }
        : { mode: audit.mode, error: record.status === "failed" ? record.error : "", batch: audit.batch.id },
    );
    await saveRunUsage(ws, usage, "audit");
    await writeRecord(session, "audit.json", record);
    return { status: "collected", record };
  } finally {
    await release();
  }
}

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
  // REQ-VER-06/AC4: the audit runs again for these results; an earlier queued audit reviewed other ones.
  const earlier = await readFile(ws.path("checks", "audit.json"), "utf8").catch(() => undefined);
  if (earlier !== undefined) {
    let earlierRaw: unknown;
    try {
      earlierRaw = JSON.parse(earlier);
    } catch {
      earlierRaw = undefined;
    }
    const parsedEarlier = AuditRecordSchema.safeParse(earlierRaw);
    if (parsedEarlier.success && parsedEarlier.data.status === "queued") {
      events.emit("audit", SYSTEM, "audit.superseded", { batch: parsedEarlier.data.batch.id });
      await dropRecord(session, "audit.json");
      await dropRecord(session, AUDIT_REQUEST);
    }
  }
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
  const usage = runUsage(session);
  const deps = {
    ws,
    models: session.models,
    events,
    usage,
    now,
    maskJson: (v: unknown) => masker.maskJson(v),
    maskText: (t: string) => masker.maskText(t),
  };
  let record: AuditRecord;
  // REQ-VER-06/AC4: through the provider's batch API when the project asks; a provider without one audits now.
  if (project.config.verification.auditor_delivery === "batch") {
    const queued = await queuedAuditRecord(
      session,
      deps,
      { plan: verdict.plan, cases, texts, images },
      mode,
      now,
    );
    if (queued) {
      await saveRunUsage(ws, usage, "audit");
      await writeRecord(session, "audit.json", queued);
      return queued;
    }
  }
  try {
    const result = await runAuditor(deps, { plan: verdict.plan, cases, texts, images });
    record = AuditRecordSchema.parse({ schema: 1, status: "done", mode, ...result });
    // REQ-PLAN-16/AC4: how many PASSED the auditor downgraded, for the project's metrics.
    events.emit("audit", SYSTEM, "audit.done", {
      cases: result.findings.length,
      weak: result.findings.filter((f) => f.weak).length,
    });
  } catch (error) {
    record = {
      schema: 1,
      status: "failed",
      mode,
      error: masker.maskText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
    events.emit("audit", SYSTEM, "audit.failed", { mode, error: record.error });
  }
  await saveRunUsage(ws, usage);
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
      const { runCases } = await sessionPlugins(session).load<typeof RunnerApiPlugin>("runner-api");
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
  const usage = runUsage(session);
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
  await saveRunUsage(ws, usage);
  await writeRecord(session, "triage.json", record);
  return record;
}

/**
 * Explains every BLOCKED case with a likely cause and a next step (REQ-VER-13) and writes `checks/blocked.json`. Hints
 * are kept only when their citations exist; a model error is recorded and the run goes on. Hints never change a
 * status (invariant 1). Switched with `verification.triage`, like the hints for FAILED cases.
 */
export async function blockedRun(session: RunSession, now: () => Date): Promise<BlockedRecord | undefined> {
  const { project, ws, masker, events } = session;
  if (project.config.verification.triage === "off") return undefined;
  const verdict = await computeVerdict(session, now);
  const blocked = verdict.cases.filter((c) => c.status === "BLOCKED").map((c) => c.caseId);
  if (blocked.length === 0) return undefined;
  const specs: Record<string, string> = {};
  for (const caseId of blocked) {
    const spec = await readFile(ws.path("specs", `${caseId}.spec.ts`), "utf8").catch(() => undefined);
    if (spec !== undefined) specs[caseId] = masker.maskText(spec);
  }
  const cases = blocked.flatMap((caseId) => {
    const result = verdict.results.get(caseId);
    return result
      ? [{ caseId, result, evidence: result.attempts.at(-1)?.evidence ?? [], spec: specs[caseId] }]
      : [];
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
  const usage = runUsage(session);
  let record: BlockedRecord;
  try {
    const answer = await runBlockedHints(
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
    const checked = checkBlockedHints(
      answer.hints.map((h) => ({
        ...h,
        justification: masker.maskText(h.justification),
        next: masker.maskText(h.next),
      })),
      {
        results: verdict.results,
        manifest: verdict.manifest.map((m) => m.path),
        logs: logNames,
        specs,
        blocked,
      },
    );
    record = BlockedRecordSchema.parse({ schema: 1, status: "done", model: answer.model, ...checked });
  } catch (error) {
    record = {
      schema: 1,
      status: "failed",
      error: masker.maskText(error instanceof Error ? error.message : String(error)).slice(0, 500),
    };
    events.emit("triage", SYSTEM, "blocked.failed", { error: record.error });
  }
  await saveRunUsage(ws, usage);
  await writeRecord(session, "blocked.json", record);
  return record;
}
