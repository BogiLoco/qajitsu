import { ConfigError, fragment, sha256, type ModelExchange } from "@qajitsu/core";
import { z } from "zod";
import { atBatchPrice, type BatchRef } from "@qajitsu/models";
import type { ModelMessage } from "ai";
import { auditFragments, AuditReportSchema, type AuditInput, type AuditResult } from "./auditor.js";
import { TokenBudgetExceededError } from "./errors.js";
import { plain } from "./exchange.js";
import { extractJson } from "./loop.js";
import { prepareCall } from "./prepare-call.js";
import { assembleFor, modelForRole, type AgentStageDeps } from "./roles-run.js";
import { callUsage, recordCall } from "./usage.js";

/** The id of the audit's one call inside its batch. */
const CALL_ID = "audit";

/** An audit sent to the provider's batch API (REQ-VER-06/AC4), what `checks/audit.json` keeps until it is collected. */
export interface QueuedAudit {
  readonly model: string;
  readonly sameModelAsAuthor: boolean;
  /** The PASSED cases it reviews: findings for any other case are refused when it is collected. */
  readonly passed: readonly string[];
  readonly batch: BatchRef;
  readonly expiresAt?: string | undefined;
  /** The request as sent, as the transcript keeps it (binary parts as their hash); recorded when it is collected. */
  readonly request: unknown;
  /** SHA-256 of `JSON.stringify(request)`. */
  readonly requestSha256: string;
}

/** What collecting a queued audit found. */
export type CollectedAudit =
  | { readonly status: "pending"; readonly counts?: { readonly completed: number; readonly total: number } }
  | { readonly status: "done"; readonly result: AuditResult }
  | {
      readonly status: "failed";
      readonly error: string;
      /**
       * The provider answered, but not with a valid report: with one attempt and no repair, such an answer could
       * hide a weak finding, so the caller treats it as a failure of a required audit (every PASSED to NEEDS_REVIEW).
       */
      readonly invalidAnswer?: true;
    };

/**
 * Sends the audit of a run's PASSED cases to the auditor provider's batch API (REQ-VER-06/AC4, REQ-LLM-12/AC3): the
 * same context as an immediate audit, without tools (a batched call cannot run them) and with one attempt.
 *
 * @returns The queued audit, or undefined when the auditor's provider has no batch API or nothing PASSED: the caller
 *   audits at once then.
 * @throws TokenBudgetExceededError when a ticket or month budget is at its limit (REQ-FLOW-06/AC5): nothing is sent.
 */
export async function queueAudit(deps: AgentStageDeps, input: AuditInput): Promise<QueuedAudit | undefined> {
  const model = await modelForRole(deps.models, "auditor");
  const passed = input.cases.filter((c) => c.status === "PASSED").map((c) => c.caseId);
  if (!model.batch || passed.length === 0) return undefined;
  const author = await deps.models.forRole("author").then(
    (m) => m.id,
    () => undefined,
  );
  const context = await assembleFor(deps, {
    stage: "audit",
    role: "auditor",
    model,
    fragments: [
      ...auditFragments(input),
      fragment({
        kind: "question",
        source: "batch",
        trust: "trusted",
        section: "varying",
        priority: 1,
        pinned: true,
        text: `No tools are available in this review: judge from the plan, results and evidence shown here. Put "audit": "${deps.ws.runId}" into your JSON object next to "findings".`,
      }),
    ],
  });
  const images = model.profile.vision ? input.images : [];
  const messages: ModelMessage[] = [
    images.length === 0
      ? { role: "user", content: context.prompt }
      : {
          role: "user",
          content: [
            { type: "text", text: context.prompt },
            ...images.flatMap((img) => [
              { type: "text" as const, text: `Image ${img.name}:` },
              { type: "file" as const, data: img.data, mediaType: img.mediaType, filename: img.name },
            ]),
          ],
        },
  ];
  const prepared = prepareCall(model, context, messages);
  await deps.usage.beforeCall("audit", "auditor", model.id, model.profile);
  const submitted = await model.batch.submit(
    [{ id: CALL_ID, system: prepared.system, messages: prepared.messages }],
    deps.signal,
  );
  const request = plain({ system: prepared.system, messages: prepared.messages });
  const requestSha256 = sha256(JSON.stringify(request));
  const batch: BatchRef = { version: 2, id: submitted.id, provider: submitted.provider };
  deps.events.emit("audit", { kind: "agent", name: "auditor" }, "audit.queued", {
    model: model.id,
    batch: batch.id,
    provider: batch.provider,
    cases: passed.length,
    ...(submitted.expiresAt ? { expiresAt: submitted.expiresAt } : {}),
  });
  return {
    model: model.id,
    sameModelAsAuthor: model.id === author,
    passed,
    batch,
    ...(submitted.expiresAt ? { expiresAt: submitted.expiresAt } : {}),
    request,
    requestSha256,
  };
}

/**
 * Collects a queued audit (REQ-VER-06/AC4): still pending, or its answer checked like an immediate audit's (one
 * finding for each PASSED case it reviewed, nothing else). A batch that failed, expired or was cancelled, and an
 * answer that is not a valid report, are a failed audit; the configured mode decides what that means for the
 * statuses. The call's tokens and cost, at the batch price, are recorded with its prompt and answer.
 *
 * @param deps - The stage's dependencies.
 * @param queued - What was queued.
 */
export async function collectAudit(
  deps: AgentStageDeps,
  queued: QueuedAudit,
  options: { readonly alreadyRecorded?: boolean } = {},
): Promise<CollectedAudit> {
  const model = await deps.models.resolve(queued.model);
  if (!model.batch)
    throw new ConfigError(
      "BATCH_UNAVAILABLE",
      `${queued.model} has no batch API any more; the queued audit cannot be collected.`,
      { model: queued.model },
    );
  const state = await model.batch.status(queued.batch, deps.signal);
  if (state.state === "pending")
    return {
      status: "pending",
      ...(state.counts ? { counts: { completed: state.counts.completed, total: state.counts.total } } : {}),
    };
  if (state.state === "failed")
    return { status: "failed", error: `the batch failed: ${state.error ?? "no reason given"}` };
  const answer = (await model.batch.answers(queued.batch, deps.signal)).find((a) => a.id === CALL_ID);
  if (!answer) return { status: "failed", error: "the batch has no answer for the audit" };
  if (answer.status !== "succeeded")
    return { status: "failed", error: `the audit call ${answer.status}: ${answer.error}` };
  const usage = callUsage(answer.usage);
  const exchange: ModelExchange = {
    stage: "audit",
    role: "auditor",
    model: model.id,
    ...(typeof model.model === "object" ? { provider: model.model.provider } : {}),
    request: queued.request,
    response: { text: answer.text, steps: [] },
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
  // Recorded once per batch: a collect that stopped before writing its record does not count the call again.
  if (options.alreadyRecorded !== true) {
    try {
      // One review for every PASSED case it saw, shared equally (REQ-FLOW-06/AC3), at the batch price.
      await recordCall(
        deps.usage,
        "audit",
        "auditor",
        model.id,
        atBatchPrice(model.profile, model.batch.priceFactor),
        usage,
        exchange,
        { caseIds: [...queued.passed], apportioned: true },
      );
    } catch (error) {
      // The call was made, paid for and written; a budget it exhausted stops later work, not this audit's result.
      if (!(error instanceof TokenBudgetExceededError)) throw error;
    }
    deps.events.emit("audit", { kind: "agent", name: "auditor" }, "audit.batch_recorded", {
      batch: queued.batch.id,
    });
  }
  let raw: unknown;
  try {
    raw = extractJson(answer.text);
  } catch (error) {
    return {
      status: "failed",
      error: `the answer is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      invalidAnswer: true,
    };
  }
  // The answer names the run it reviewed: an answer of another run's batch is refused (REQ-VER-06/AC4).
  const parsed = AuditReportSchema.extend({ audit: z.string() }).safeParse(raw);
  if (!parsed.success)
    return { status: "failed", error: "the answer is not a valid audit report", invalidAnswer: true };
  if (parsed.data.audit !== deps.ws.runId)
    return {
      status: "failed",
      error: `the answer reviews run ${parsed.data.audit.slice(0, 40)}, not ${deps.ws.runId}`,
      invalidAnswer: true,
    };
  const ids = parsed.data.findings.map((f) => f.caseId);
  const problems = [
    ...queued.passed.filter((id) => !ids.includes(id)).map((id) => `no finding for ${id}`),
    ...ids.filter((id) => !queued.passed.includes(id)).map((id) => `${id} is not a PASSED case it reviewed`),
    ...ids.filter((id, i) => ids.indexOf(id) !== i).map((id) => `${id} appears more than once`),
  ];
  if (problems.length > 0)
    return {
      status: "failed",
      error: `the audit report is invalid: ${problems.join("; ")}`,
      invalidAnswer: true,
    };
  deps.events.emit("audit", { kind: "agent", name: "auditor" }, "audit.collected", {
    batch: queued.batch.id,
    weak: parsed.data.findings.filter((f) => f.weak).map((f) => f.caseId),
  });
  return {
    status: "done",
    result: { model: model.id, sameModelAsAuthor: queued.sameModelAsAuthor, findings: parsed.data.findings },
  };
}
