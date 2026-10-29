import { z } from "zod";
import {
  BLOCKED_CATEGORIES,
  BlockedCiteSchema,
  ConfigError,
  fragment,
  type CaseResultFile,
  type ContextFragment,
  type Plan,
} from "@qajitsu/core";
import { runStructuredAgent } from "./loop.js";
import { AGENT_ROLES } from "./roles.js";
import {
  assembleFor,
  instructions,
  modelForRole,
  question,
  stageGuard,
  type AgentStageDeps,
} from "./roles-run.js";
import { createReadOnlyTools } from "./workspace-tools.js";

/** The model's answer: at most one hint per BLOCKED case (REQ-VER-13/AC1). */
export const BlockedAnswerSchema = z.strictObject({
  hints: z.array(
    z.strictObject({
      caseId: z.string(),
      category: z.enum(BLOCKED_CATEGORIES),
      justification: z.string().min(1).max(600),
      next: z.string().min(1).max(300),
      cites: z.array(BlockedCiteSchema).min(1).max(8),
    }),
  ),
});

/** What the agent receives: BLOCKED cases with their record, spec, evidence and the run's log excerpts. */
export interface BlockedInput {
  readonly plan: Plan;
  readonly cases: readonly {
    readonly caseId: string;
    readonly result: CaseResultFile;
    readonly evidence: readonly string[];
    /** The spec that ran, when the author produced one. */
    readonly spec?: string | undefined;
  }[];
  /** Masked text evidence excerpts by manifest path. */
  readonly texts: Readonly<Record<string, string>>;
  /** Masked tails of the run's log files by name (relative to `logs/`). */
  readonly logs: Readonly<Record<string, string>>;
}

/** System prompt of the BLOCKED explanation (REQ-VER-13). */
export const BLOCKED_SYSTEM = `You explain to a tester why QAJitsu could not judge some test cases.
The cases below are BLOCKED: the test could not run to a verdict. The status was computed by code and nothing you say changes it.
For each case give the most likely cause and the next step the tester can take:
- spec: the generated test is wrong (an operation the app does not have, a selector that matches nothing, a wrong flow);
- plan: an expectation names something the application does not show or cannot be checked as written;
- environment: the application or a dependency was not reachable or not healthy;
- tooling: the browser, device, emulator or Appium failed;
- configuration: the project or environment configuration is missing or wrong (accounts, URLs, app binary, keys).
Cite what your explanation rests on, using only what is listed: {"kind":"error","ref":"error"} (the attempt's error),
{"kind":"spec","ref":"<line number>"}, {"kind":"step","ref":"S1"}, {"kind":"evidence","ref":"<evidence path>"},
{"kind":"log","ref":"<log file>"}. Citations are checked by code; a hint whose citations do not exist is thrown away.
The next step is one concrete action in plain words (a command, or a plan or config change). The approved plan of this run
is frozen: a plan problem is fixed in a new run (qj fetch, qj plan) by correcting the expectation in the review. verify()
calls belong to the spec, which QAJitsu writes again in a new run; they are never added to the plan. When unsure, say so.
Answer with one JSON object only:
{ "hints": [{ "caseId": "TC-01", "category": "spec", "justification": "short, concrete", "next": "what to do", "cites": [{ "kind": "error", "ref": "error" }] }] }`;

const numbered = (source: string): string =>
  source
    .split("\n")
    .map((line, i) => `${String(i + 1).padStart(3)}| ${line}`)
    .join("\n");

/**
 * The context of the BLOCKED hints as fragments (REQ-CTX-11): plan (pinned), runner output, the generated spec with
 * line numbers, evidence and log tails (untrusted), the evidence list built by code, and the question.
 */
export function blockedFragments(input: BlockedInput): ContextFragment[] {
  const at = (
    over: Omit<Parameters<typeof fragment>[0], "section" | "priority" | "pinned"> & {
      pinned?: boolean;
      priority?: number;
    },
  ) => fragment({ section: "varying", priority: 50, pinned: false, ...over });
  const out: ContextFragment[] = [
    instructions("blocked", BLOCKED_SYSTEM),
    at({
      kind: "question",
      source: "intro",
      trust: "trusted",
      priority: 90,
      pinned: true,
      text: `Ticket ${input.plan.ticket}, plan v${String(input.plan.version)}. BLOCKED cases (statuses computed by code):`,
    }),
  ];
  for (const c of input.cases) {
    const planCase = input.plan.cases.find((p) => p.id === c.caseId);
    const last = c.result.attempts.at(-1);
    out.push(
      at({
        kind: "plan",
        source: `${c.caseId}/plan`,
        trust: "trusted",
        pinned: true,
        text: JSON.stringify(planCase ?? {}, null, 2),
      }),
      at({
        kind: "result",
        source: `${c.caseId}/results.json`,
        trust: "untrusted",
        text: JSON.stringify({ steps: last?.steps ?? [], error: last?.error }, null, 2),
      }),
      c.spec === undefined
        ? at({
            kind: "spec",
            source: `${c.caseId}/spec`,
            trust: "trusted",
            text: "No spec: the author did not produce one.",
          })
        : at({ kind: "spec", source: `${c.caseId}/spec`, trust: "untrusted", text: numbered(c.spec) }),
      at({
        kind: "evidence",
        source: `${c.caseId}/evidence (list)`,
        trust: "trusted",
        text: c.evidence.map((e) => `- ${e}`).join("\n") || "- none",
      }),
      ...c.evidence
        .filter((e) => input.texts[e] !== undefined)
        .map((e) =>
          at({
            kind: "evidence",
            source: `${c.caseId}/evidence/${e}`,
            trust: "untrusted",
            text: (input.texts[e] ?? "").slice(0, 2000),
          }),
        ),
    );
  }
  for (const [name, text] of Object.entries(input.logs))
    out.push(at({ kind: "log", source: `logs/${name}`, trust: "untrusted", priority: 40, text }));
  out.push(
    question(
      Object.keys(input.logs).length > 0
        ? "Answer with the JSON object."
        : "No log files.\nAnswer with the JSON object.",
    ),
  );
  return out;
}

/**
 * Stage `blocked`: explains every BLOCKED case with a next step and citations (REQ-VER-13/AC1). Runs with the model of
 * the `triage` role. The caller keeps only hints whose citations exist (`checkBlockedHints`) and never lets them touch
 * a status (AC2).
 *
 * @throws {AgentOutputError} When the model cannot produce a valid answer; the caller records the failure.
 */
export async function runBlockedHints(
  deps: AgentStageDeps,
  input: BlockedInput,
): Promise<{ readonly model: string; readonly hints: z.infer<typeof BlockedAnswerSchema>["hints"] }> {
  const role = AGENT_ROLES.find((r) => r.role === "triage");
  if (!role) throw new ConfigError("ROLE_UNKNOWN", "Unknown role triage.", { role: "triage" });
  const model = await modelForRole(deps.models, "triage");
  const ids = input.cases.map((c) => c.caseId);
  const actor = { kind: "agent", name: "triage" } as const;
  deps.events.emit("triage", actor, "blocked.start", { model: model.id, cases: ids.length });
  const { value, attempts } = await runStructuredAgent({
    stage: "triage",
    role: "triage",
    model,
    // REQ-CTX-12: assembled from fragments, its snapshot in the journal (REQ-CTX-17/AC3).
    context: assembleFor(deps, {
      stage: "triage",
      role: "blocked",
      model: model.id,
      fragments: blockedFragments(input),
    }),
    schema: BlockedAnswerSchema,
    validate: (answer) => {
      const seen = answer.hints.map((h) => h.caseId);
      return [
        ...seen.filter((id) => !ids.includes(id)).map((id) => `hints: ${id} is not a BLOCKED case`),
        ...seen.filter((id, i) => seen.indexOf(id) !== i).map((id) => `hints: ${id} appears more than once`),
      ];
    },
    tools: createReadOnlyTools({ root: deps.ws.dir, mask: deps.maskText }),
    guard: stageGuard(deps, "triage", role),
    usage: deps.usage,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  deps.events.emit("triage", actor, "blocked.end", { attempts, hints: value.hints.length });
  return { model: model.id, hints: value.hints };
}
