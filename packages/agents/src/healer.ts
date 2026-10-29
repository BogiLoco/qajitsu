import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fragment, type ContextFragment, type Plan, type UiScreen } from "@qajitsu/core";
import {
  assertionLockDiff,
  blockingProblems,
  checkSpecSource,
  formatSpecProblems,
  renderUiSnapshot,
  typecheckSpecs,
  type SpecProblem,
} from "@qajitsu/verifier";
import { generateText } from "ai";
import { extractCode } from "./author.js";
import { modelExchange } from "./exchange.js";
import { callUsage } from "./usage.js";
import { prepareCall } from "./prepare-call.js";
import { assembleFor, instructions, modelForRole, question, type AgentStageDeps } from "./roles-run.js";

/** Heal attempts per case (REQ-EXEC-09/AC1). */
export const HEALER_MAX_ATTEMPTS = 2;

/** System prompt of the healer role (REQ-EXEC-09). */
export const HEALER_SYSTEM = `You are the healer of QAJitsu. A web or mobile test could not run because a selector or a wait did not match the page or the screen of the app.
You may change ONLY selectors (testid:, role:, label:, text:, css: on the web; testid:, label:, text: in a native app) and waits (ui.waitFor).
Prefer a selector listed for the element under "What the page or screen showed at the failure"; those are the ones that find it. You must keep every step(), every verify() call and every plan.expect(...) exactly as they are, and you must not add try/catch. Code checks this and rejects any other change.
Answer with the complete spec in one \`\`\`ts code block and nothing else.`;

/** What the healer sees about the failure. */
export interface HealRequest {
  readonly caseId: string;
  /** Spec that failed to run. */
  readonly specFile: string;
  /** Error of the failed attempt, masked. */
  readonly error: string;
  /** DOM of the page at the failure (masked), when available. */
  readonly dom?: string | undefined;
  /** The elements of the page or screen at the failure (masked), when recorded (REQ-EXEC-22/AC4). */
  readonly screen?: UiScreen | undefined;
  /** 1-based heal attempt. */
  readonly attempt: number;
}

/**
 * Proposes a healed spec (REQ-EXEC-09/AC1-AC2). The healed copy is written to `specs/healed/` only when
 * it passes the static checks and the assertion lock; the original spec is never changed.
 *
 * @returns Path of the healed spec, or undefined when no acceptable heal was produced.
 */
export async function healSpec(
  deps: AgentStageDeps,
  plan: Plan,
  request: HealRequest,
): Promise<{ file?: string; problems: SpecProblem[] }> {
  const model = await modelForRole(deps.models, "healer");
  const original = await readFile(request.specFile, "utf8");
  const actor = { kind: "agent", name: "healer" } as const;
  deps.events.emit("heal", actor, "heal.start", {
    caseId: request.caseId,
    attempt: request.attempt,
    model: model.id,
  });
  // REQ-CTX-12: the spec to heal is the author's output (data); the failure is what the runner and page reported.
  const at = (over: Omit<Parameters<typeof fragment>[0], "section" | "pinned">): ContextFragment =>
    fragment({ section: "varying", pinned: false, ...over });
  const context = assembleFor(deps, {
    stage: "heal",
    role: "healer",
    model: model.id,
    fragments: [
      instructions("healer", HEALER_SYSTEM),
      at({
        kind: "question",
        source: "task",
        trust: "trusted",
        priority: 95,
        text: `Heal ${request.caseId}.`,
      }),
      at({
        kind: "spec",
        source: `specs/${request.caseId}.spec.ts`,
        trust: "untrusted",
        priority: 80,
        text: original,
      }),
      at({ kind: "log", source: "error", trust: "untrusted", priority: 70, text: request.error }),
      ...(request.screen
        ? [
            at({
              kind: "ui",
              source: "ui/failure",
              trust: "untrusted",
              priority: 60,
              text: renderUiSnapshot([request.screen], 120, "What the page or screen showed at the failure"),
            }),
          ]
        : []),
      ...(request.dom
        ? [
            at({
              kind: "evidence",
              source: "dom (truncated)",
              trust: "untrusted",
              priority: 50,
              text: request.dom.slice(0, 20_000),
            }),
          ]
        : []),
      question("Answer with the healed spec in one ```ts block."),
    ],
  });
  const prompt = context.prompt;
  const startedAt = Date.now();
  const result = await generateText({
    model: model.model,
    ...prepareCall(model, context, [{ role: "user", content: prompt }]),
    ...(deps.signal ? { abortSignal: deps.signal } : {}),
    maxRetries: 2,
  });
  deps.usage.record(
    "heal",
    "healer",
    model.id,
    model.profile,
    callUsage(result.usage, startedAt),
    modelExchange("heal", "healer", model, { system: context.system, prompt }, result),
  );
  const code = extractCode(result.text);
  let problems: SpecProblem[] =
    code === undefined ? [{ check: "lint", message: "answer contained no ```ts code block" }] : [];
  if (code !== undefined) {
    problems = [
      ...assertionLockDiff(original, code),
      ...blockingProblems(checkSpecSource(code, request.caseId, plan, deps.specChecks)),
    ];
  }
  let file: string | undefined;
  if (code !== undefined && problems.length === 0) {
    const candidate = deps.ws.path(
      "specs",
      "healed",
      `v${String(request.attempt)}`,
      `${request.caseId}.spec.ts`,
    );
    await mkdir(dirname(candidate), { recursive: true });
    await writeFile(candidate, code, "utf8");
    problems = typecheckSpecs([candidate]).get(candidate) ?? [];
    if (problems.length === 0) file = candidate;
  }
  deps.events.emit("heal", actor, "heal.end", {
    caseId: request.caseId,
    attempt: request.attempt,
    ok: file !== undefined,
    problems: problems.length > 0 ? formatSpecProblems(problems).slice(0, 2000) : undefined,
  });
  return { ...(file ? { file } : {}), problems };
}
