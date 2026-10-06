import { z } from "zod";
import {
  ConfigError,
  TRIAGE_CATEGORIES,
  TriageCiteSchema,
  type CaseResultFile,
  type Plan,
} from "@qajitsu/core";
import { UNTRUSTED_DATA_RULES, untrusted } from "./context.js";
import { runStructuredAgent } from "./loop.js";
import { AGENT_ROLES } from "./roles.js";
import { modelForRole, stageGuard, type AgentStageDeps } from "./roles-run.js";
import { createReadOnlyTools } from "./workspace-tools.js";

/** The model's answer: at most one hint per FAILED case (REQ-VER-12/AC1). */
export const TriageAnswerSchema = z.strictObject({
  hints: z.array(
    z.strictObject({
      caseId: z.string(),
      category: z.enum(TRIAGE_CATEGORIES),
      justification: z.string().min(1).max(600),
      cites: z.array(TriageCiteSchema).min(1).max(8),
    }),
  ),
});

/** What the triage agent receives: FAILED cases with their record, evidence, and the run's log excerpts. */
export interface TriageInput {
  readonly plan: Plan;
  readonly cases: readonly {
    readonly caseId: string;
    readonly result: CaseResultFile;
    readonly evidence: readonly string[];
  }[];
  /** Masked text evidence excerpts by manifest path. */
  readonly texts: Readonly<Record<string, string>>;
  /** Masked tails of the run's log files by name (relative to `logs/`). */
  readonly logs: Readonly<Record<string, string>>;
}

/** System prompt of the triage role (REQ-VER-12). */
export const TRIAGE_SYSTEM = `You are the failure triage assistant of QAJitsu, an agentic QA framework.
The cases below FAILED; their status was computed by code from the test runner and nothing you say changes it.
For each case suggest the most likely cause:
- product-bug: the application behaves differently from the approved plan (wrong value, error, missing element);
- test-bug: the test itself is wrong (wrong selector, wrong step order, a wait that is too short) while the app looks right;
- environment: the environment was not usable (service down, timeouts, 5xx from a dependency, missing configuration);
- data: test data was missing or in the wrong state (unknown product, account locked, previous run left data).
${UNTRUSTED_DATA_RULES}
Cite the evidence your suggestion rests on, using only what is listed: {"kind":"step","ref":"S1"},
{"kind":"assertion","ref":"S1.status"}, {"kind":"evidence","ref":"<evidence path>"}, {"kind":"log","ref":"<log file>"}.
Citations are checked by code; a hint whose citations do not exist is thrown away. When unsure, say so in the justification.
Answer with one JSON object only:
{ "hints": [{ "caseId": "TC-01", "category": "product-bug", "justification": "short, concrete", "cites": [{ "kind": "assertion", "ref": "S1.status" }] }] }`;

const render = (input: TriageInput): string =>
  [
    `Ticket ${input.plan.ticket}, plan v${String(input.plan.version)}. FAILED cases:`,
    ...input.cases.map((c) => {
      const planCase = input.plan.cases.find((p) => p.id === c.caseId);
      const last = c.result.attempts.at(-1);
      return [
        `### ${c.caseId} (status FAILED, computed by code)`,
        "Plan (approved, trusted):",
        JSON.stringify(planCase ?? {}, null, 2),
        "Last attempt (runner output):",
        untrusted(
          `results/${c.caseId}.json`,
          JSON.stringify(
            { steps: last?.steps ?? [], assertions: last?.assertions ?? [], error: last?.error },
            null,
            2,
          ),
        ),
        "Evidence files:",
        c.evidence.map((e) => `- ${e}`).join("\n") || "- none",
        ...c.evidence
          .filter((e) => input.texts[e] !== undefined)
          .map((e) => untrusted(`evidence/${e}`, (input.texts[e] ?? "").slice(0, 2000))),
      ].join("\n");
    }),
    Object.keys(input.logs).length > 0
      ? [
          "Log files (tails):",
          ...Object.entries(input.logs).map(
            ([name, text]) => `- ${name}\n${untrusted(`logs/${name}`, text)}`,
          ),
        ].join("\n")
      : "No log files.",
    "Answer with the JSON object.",
  ].join("\n\n");

/**
 * Stage `triage`: suggests a cause for every FAILED case with citations (REQ-VER-12/AC1). The caller keeps only
 * hints whose citations exist (`checkTriageHints`) and never lets them touch a status (REQ-VER-12/AC2).
 *
 * @throws {AgentOutputError} When the model cannot produce a valid answer; the caller records the failure.
 */
export async function runTriage(
  deps: AgentStageDeps,
  input: TriageInput,
): Promise<{ readonly model: string; readonly hints: z.infer<typeof TriageAnswerSchema>["hints"] }> {
  const role = AGENT_ROLES.find((r) => r.role === "triage");
  if (!role) throw new ConfigError("ROLE_UNKNOWN", "Unknown role triage.", { role: "triage" });
  const model = await modelForRole(deps.models, "triage");
  const ids = input.cases.map((c) => c.caseId);
  const actor = { kind: "agent", name: "triage" } as const;
  deps.events.emit("triage", actor, "stage.start", { model: model.id, cases: ids.length });
  const { value, attempts } = await runStructuredAgent({
    stage: "triage",
    role: "triage",
    model,
    system: TRIAGE_SYSTEM,
    prompt: render(input),
    schema: TriageAnswerSchema,
    validate: (answer) => {
      const seen = answer.hints.map((h) => h.caseId);
      return [
        ...seen.filter((id) => !ids.includes(id)).map((id) => `hints: ${id} is not a FAILED case`),
        ...seen.filter((id, i) => seen.indexOf(id) !== i).map((id) => `hints: ${id} appears more than once`),
      ];
    },
    tools: createReadOnlyTools({ root: deps.ws.dir, mask: deps.maskText }),
    guard: stageGuard(deps, "triage", role),
    usage: deps.usage,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  deps.events.emit("triage", actor, "stage.end", { attempts, hints: value.hints.length });
  return { model: model.id, hints: value.hints };
}
