import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { Plan } from "@qajitsu/core";
import {
  assertionLockDiff,
  blockingProblems,
  checkSpecSource,
  formatSpecProblems,
  typecheckSpecs,
  type SpecProblem,
} from "@qajitsu/verifier";
import { generateText } from "ai";
import { extractCode } from "./author.js";
import { untrusted, UNTRUSTED_DATA_RULES } from "./context.js";
import { modelForRole, type AgentStageDeps } from "./roles-run.js";

/** Heal attempts per case (REQ-EXEC-09/AC1). */
export const HEALER_MAX_ATTEMPTS = 2;

/** System prompt of the healer role (REQ-EXEC-09). */
export const HEALER_SYSTEM = `You are the healer of QAJitsu. A web test could not run because a selector or a wait did not match the page.
${UNTRUSTED_DATA_RULES}
You may change ONLY selectors (testid:, role:, label:, text:, css:) and waits (ui.waitFor). You must keep every step(), every verify() call and every plan.expect(...) exactly as they are, and you must not add try/catch. Code checks this and rejects any other change.
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
  const result = await generateText({
    model: model.model,
    system: HEALER_SYSTEM,
    prompt: [
      `Heal ${request.caseId}.`,
      "## Spec",
      "```ts",
      original,
      "```",
      "## Error",
      untrusted("error", request.error),
      ...(request.dom
        ? ["## Page DOM at the failure (truncated)", untrusted("dom", request.dom.slice(0, 20_000))]
        : []),
    ].join("\n"),
    ...(deps.signal ? { abortSignal: deps.signal } : {}),
    maxRetries: 2,
  });
  deps.usage.record("heal", "healer", model.id, model.profile, {
    inputTokens: result.usage.inputTokens ?? 0,
    outputTokens: result.usage.outputTokens ?? 0,
  });
  const code = extractCode(result.text);
  let problems: SpecProblem[] =
    code === undefined ? [{ check: "lint", message: "answer contained no ```ts code block" }] : [];
  if (code !== undefined) {
    problems = [
      ...assertionLockDiff(original, code),
      ...blockingProblems(checkSpecSource(code, request.caseId, plan)),
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
