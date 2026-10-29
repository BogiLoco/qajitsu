import { fillMissingEvidence, withPlacementHint } from "./plan-hints.js";
import {
  createContextManager,
  type AssembledContext,
  type ContextBudget,
  type ContextManager,
} from "./context-manager.js";
import type { McpClientLike, McpServers } from "./mcp.js";
import { writeFile } from "node:fs/promises";
import {
  AnalysisSchema,
  ConfigError,
  PlanDraftSchema,
  PlanSchema,
  fragment,
  mapAroundIds,
  recordRunDocs,
  type Analysis,
  type EventLog,
  type KnowledgeChunk,
  type ContextFragment,
  type Plan,
  type PlanDraft,
  type RunWorkspace,
} from "@qajitsu/core";
import { DEFAULT_PROTECTED_PATHS, createGuard, createJournal, type Guard } from "@qajitsu/guard";
import { contextBudget, type ModelRegistry, type ResolvedModel } from "@qajitsu/models";
import {
  checkAnalysisSources,
  checkExistingCoverage,
  checkPlanSources,
  formatPlanFlags,
  indexDiff,
  type PlanFlag,
  type SourceContext,
  type SpecCheckOptions,
} from "@qajitsu/verifier";
import type { ModelMessage } from "ai";
import { stringify } from "yaml";
import { z } from "zod";
import {
  joinBySimilarity,
  nearDuplicates,
  searchByMeaning,
  similarities,
  type SemanticIndex,
} from "./context-semantic.js";
import { compactMessages } from "./context-compact.js";
import { summarise, type SummaryPolicy } from "./context-summary.js";
import { changeFits, changeGroups, mergeAnalyses, splitChange, type ChangePart } from "./change-split.js";
import { changeContextFragments, type ChangeContext } from "./context.js";
import { AgentOutputError } from "./errors.js";
import {
  annotateDocSources,
  createKnowledgeTools,
  documentationFragments,
  type KnowledgeAccess,
} from "./knowledge-tools.js";
import { runStructuredAgent, type AgentTool } from "./loop.js";
import { ANALYST_SYSTEM, PLANNER_SYSTEM } from "./prompts.js";
import { AGENT_ROLES, missingCapabilities, type AgentRoleDefinition } from "./roles.js";
import type { UsageTracker } from "./usage.js";
import { createReadOnlyTools } from "./workspace-tools.js";

/** Ports shared by agent stages. */
export interface AgentStageDeps {
  readonly ws: RunWorkspace;
  readonly models: ModelRegistry;
  readonly events: EventLog;
  readonly usage: UsageTracker;
  readonly now: () => Date;
  /** Masker for JSON values (journal) and text (tool output). */
  readonly maskJson: (value: unknown) => unknown;
  readonly maskText: (text: string) => string;
  readonly signal?: AbortSignal;
  /**
   * MCP servers for exploration (REQ-EXEC-01): the environment allowlist and, in tests, a client factory. The
   * servers run in a temporary folder outside the run workspace.
   */
  /** The run's project knowledge base (REQ-KNOW-06); absent when the project has none. */
  readonly knowledge?: KnowledgeAccess;
  readonly mcp?: {
    readonly servers: McpServers;
    readonly allowedOrigins: readonly string[];
    readonly connect?: (command: string, args: readonly string[], cwd: string) => Promise<McpClientLike>;
  };
  /**
   * Checks a drafted plan for expectations a test could not compare with (REQ-PLAN-09); code, not a model. A plan
   * with findings goes back to the planner once.
   */
  readonly planQuality?: (plan: Plan) => readonly PlanFlag[];
  /** Project-dependent options of the static spec checks (REQ-EXEC-03), e.g. deep links of the native app. */
  readonly specChecks?: SpecCheckOptions;
  /**
   * When a model may summarise context that does not fit (REQ-CTX-14/AC5, `models.context_summaries`): `off` (the
   * default here), `no-tools` (only for a role whose model cannot read handles) or `allowed`.
   */
  readonly contextSummaries?: SummaryPolicy;
  /**
   * The project's embedding model as a second signal for choosing context (REQ-CTX-20); absent without one, and the
   * manager then works on the code's signals alone (AC6).
   */
  readonly semantic?: SemanticIndex;
  /** The run's context manager (ADR-0014): one per run, so its block marker is the same for every call. */
  readonly context?: ContextManager;
}

/**
 * Assembles a role's input from fragments within the model's budget and records its snapshot in the journal
 * (REQ-CTX-12, REQ-CTX-14, REQ-CTX-17/AC3). Where the provider counts tokens (REQ-LLM-15/AC2), an input near the budget
 * is counted there and reduced further when the count is over it. `read_context` and `search_context` come with the
 * input when something was put behind a handle; every read is journaled (REQ-CTX-12/AC4).
 *
 * @param deps - The stage's dependencies.
 * @param call - Stage, role (its declaration in `ROLE_CONTEXT` applies), the resolved model and fragments.
 */
export async function assembleFor(
  deps: AgentStageDeps,
  call: {
    readonly stage: string;
    readonly role: string;
    readonly model: Pick<ResolvedModel, "id"> &
      Partial<Pick<ResolvedModel, "context" | "inputLimit" | "countTokens" | "profile">>;
    readonly fragments: readonly ContextFragment[];
  },
): Promise<AssembledContext> {
  const manager = contextOf(deps);
  const profile = call.model.context;
  const budgetOf = (tokens: number): ContextBudget | undefined =>
    profile
      ? {
          tokens,
          margin: profile.margin,
          counting: profile.counting,
          style: profile.style,
          profile: profile.version,
        }
      : undefined;
  const planned = profile ? contextBudget(profile, call.model.inputLimit?.limit) : undefined;
  const run = (
    tokens: number | undefined,
    summaries?: Parameters<ContextManager["assemble"]>[0]["summaries"],
  ) =>
    manager.assemble({
      stage: call.stage,
      role: call.role,
      model: call.model.id,
      fragments: call.fragments,
      budget: tokens === undefined ? undefined : budgetOf(tokens),
      ...(signals ?? {}),
      ...(summaries ? { summaries } : {}),
    });
  const signals = deps.semantic ? await semanticSignals(deps, call) : undefined;
  let tokens = planned;
  let context = run(tokens);
  // REQ-LLM-15/AC2: near the budget, the provider's own count decides; an input over it is reduced once more.
  const used = context.snapshot.budget?.used ?? 0;
  if (planned !== undefined && call.model.countTokens && used > planned * 0.8) {
    const counted = await call.model.countTokens(context.system, context.prompt).catch(() => undefined);
    if (counted !== undefined && counted > planned) {
      tokens = Math.max(0, Math.floor(planned * (planned / counted)) - 256);
      context = run(tokens);
    }
  }
  const summaries = await summariesFor(deps, call, context);
  if (summaries.size > 0) context = run(tokens, summaries);
  deps.events.emit(call.stage, { kind: "agent", name: call.role }, "context.snapshot", {
    ...context.snapshot,
  });
  const budget = context.snapshot.budget;
  return {
    ...context,
    // With a budget the loop may compact (REQ-CTX-16), so the role can always read what was put behind a handle.
    tools: context.snapshot.catalogue.length > 0 || budget ? contextTools(deps, manager, call) : [],
    ...(budget
      ? {
          compact: (messages: readonly ModelMessage[], canRead: boolean) => {
            const done = compactMessages(messages, {
              system: context.system,
              budget: budget.tokens,
              margin: budget.margin,
              keep: canRead
                ? (toolName, text) =>
                    manager.keep(
                      fragment({
                        kind: "tool-result",
                        source: `tool:${toolName}`,
                        trust: "untrusted",
                        section: "varying",
                        priority: 0,
                        pinned: false,
                        text,
                      }),
                    )
                : undefined,
            });
            if (!done) return undefined;
            deps.events.emit(call.stage, { kind: "agent", name: call.role }, "context.compacted", {
              snapshot: context.snapshot.sha256,
              reductions: done.compactions,
              tokensSaved: done.compactions.reduce((n, c) => n + c.tokensSaved, 0),
            });
            return done.messages;
          },
        }
      : {}),
  };
}

/** Over-budget fragments summarised per call at most: summaries are the last resort, not a pipeline. */
const MAX_SUMMARIES = 4;

/**
 * Summaries for a call whose code reductions left fragments out (REQ-CTX-14/AC5): only when the project's policy
 * allows it (by default only for a role whose model cannot read handles), only for non-pinned fragments the budget
 * shelved, the largest first, and never for the summary role itself.
 */
async function summariesFor(
  deps: AgentStageDeps,
  call: {
    readonly stage: string;
    readonly role: string;
    readonly model: Partial<Pick<ResolvedModel, "profile">>;
    readonly fragments: readonly ContextFragment[];
  },
  context: AssembledContext,
): Promise<Map<string, { fragment: ContextFragment; model: string }>> {
  const out = new Map<string, { fragment: ContextFragment; model: string }>();
  const policy = deps.contextSummaries ?? "off";
  const canRead = call.model.profile?.tools !== false;
  if (call.role === "summary" || policy === "off" || (policy === "no-tools" && canRead)) return out;
  const shelved = new Set(
    context.snapshot.reductions
      .filter((r) => r.action === "handle" && r.reason.startsWith("over budget"))
      .map((r) => r.sha256),
  );
  const candidates = call.fragments
    .filter((f) => shelved.has(f.sha256) && !f.pinned)
    .sort((a, b) => b.tokens - a.tokens || (a.sha256 < b.sha256 ? -1 : 1))
    .slice(0, MAX_SUMMARIES);
  if (candidates.length === 0) return out;
  const model = await deps.models.forRole("summary").catch(() => undefined);
  if (!model) return out;
  for (const f of candidates) {
    const summary = await summarise(deps, {
      stage: call.stage,
      model,
      fragment: f,
      assemble: (fragments) => assembleFor(deps, { stage: call.stage, role: "summary", model, fragments }),
    });
    if (summary) out.set(f.sha256, { fragment: summary, model: model.id });
  }
  return out;
}

/**
 * The embedding model's signals for a call (REQ-CTX-20/AC1, AC3, AC6): similarity of each fragment to the task and
 * near-identical fragments confirmed by code. Without the model, or when it fails, the call goes on with the code's
 * signals alone; the failure is journaled.
 */
async function semanticSignals(
  deps: AgentStageDeps,
  call: { readonly stage: string; readonly role: string; readonly fragments: readonly ContextFragment[] },
): Promise<
  | {
      semantic: Map<string, number>;
      nearDuplicates: Map<string, string>;
      embedding: { model: string; version?: string | undefined };
    }
  | undefined
> {
  const index = deps.semantic;
  if (!index) return undefined;
  try {
    return {
      semantic: await similarities(index, call.fragments),
      nearDuplicates: await nearDuplicates(index, call.fragments),
      embedding: { model: index.model, version: index.version },
    };
  } catch (error) {
    deps.events.emit(call.stage, { kind: "agent", name: call.role }, "context.semantic_unavailable", {
      model: index.model,
      reason: error instanceof Error ? error.message.slice(0, 300) : "unknown",
    });
    return undefined;
  }
}

/** The tools over the run's catalogue (REQ-CTX-12/AC4, REQ-CTX-20/AC2): their use is journaled and counted. */
function contextTools(
  deps: AgentStageDeps,
  manager: ContextManager,
  call: { readonly stage: string; readonly role: string },
): AgentTool[] {
  const actor = { kind: "agent", name: call.role } as const;
  return [
    {
      name: "read_context",
      description:
        "Read in full a piece of this task's context that is behind a handle (h-xxxxxxxx) in the catalogue.",
      inputSchema: z.object({ handle: z.string().regex(/^h-[0-9a-f]{8}$/) }),
      execute: (input) => {
        const handle = String(input["handle"]);
        const text = manager.read(handle);
        deps.events.emit(call.stage, actor, "context.read", { handle, found: text !== undefined });
        return Promise.resolve(text ?? `No ${handle} in the catalogue.`);
      },
    },
    {
      name: "search_context",
      description:
        "Find pieces of this task's context behind handles by their subject, e.g. 'payment error handling'; returns handles to read.",
      inputSchema: z.object({ question: z.string().min(2).max(300) }),
      execute: async (input) => {
        const asked = String(input["question"]);
        const byWords = manager.search(asked);
        // REQ-CTX-20/AC2: with an embedding model the catalogue is also searched by meaning; the code's matches first.
        const shelved = manager.shelved();
        const byMeaning = deps.semantic
          ? await searchByMeaning(deps.semantic, asked, shelved, 5).catch(() => [])
          : [];
        const hits = [
          ...byWords,
          ...byMeaning
            .filter((m) => !byWords.some((w) => w.handle === m.handle))
            .flatMap((m) => {
              const f = shelved.find((e) => e.handle === m.handle)?.fragment;
              return f ? [{ handle: m.handle, kind: f.kind, source: f.source, tokens: f.tokens }] : [];
            }),
        ].slice(0, 8);
        deps.events.emit(call.stage, actor, "context.search", {
          hits: hits.length,
          ...(deps.semantic ? { semantic: byMeaning.length } : {}),
        });
        return hits.length === 0
          ? "Nothing in the catalogue matches; try other words."
          : manager.wrap(
              "search_context",
              hits
                .map((h) => `- ${h.handle} · ${h.kind} · ${h.source} · ${String(h.tokens)} tokens`)
                .join("\n"),
            );
      },
    },
  ];
}

/** A role's instructions: trusted, pinned, first. */
export const instructions = (role: string, text: string): ContextFragment =>
  fragment({
    kind: "role-instructions",
    source: role,
    trust: "trusted",
    section: "stable",
    priority: 100,
    pinned: true,
    text,
  });

/** The closing question of a call: trusted, last. */
export const question = (text: string): ContextFragment =>
  fragment({
    kind: "question",
    source: "question",
    trust: "trusted",
    section: "varying",
    priority: 0,
    pinned: true,
    text,
  });

const fallbackContexts = new WeakMap<object, ContextManager>();

/**
 * The context manager of a run: the one the run gave, or one kept for these dependencies, so every call of the run
 * uses the same block marker (REQ-CTX-15/AC1).
 *
 * @param deps - The stage's dependencies.
 */
export function contextOf(deps: AgentStageDeps): ContextManager {
  if (deps.context) return deps.context;
  const key = deps.events as object;
  let made = fallbackContexts.get(key);
  if (!made) {
    made = createContextManager();
    fallbackContexts.set(key, made);
  }
  return made;
}

const roleDef = (role: AgentRoleDefinition["role"]): AgentRoleDefinition => {
  const def = AGENT_ROLES.find((r) => r.role === role);
  if (!def) throw new ConfigError("ROLE_UNKNOWN", `Unknown role ${role}.`, { role });
  return def;
};

/**
 * Resolves the role's model and refuses models without a required capability (REQ-LLM-03/AC3).
 *
 * @throws {ConfigError} `MODEL_CAPABILITY_MISSING` listing what is missing.
 */
export async function modelForRole(
  models: ModelRegistry,
  role: Exclude<AgentRoleDefinition["role"], "approver">,
): Promise<ResolvedModel> {
  const resolved = await models.forRole(role);
  const missing = missingCapabilities(roleDef(role), resolved.profile);
  if (missing.length > 0) {
    throw new ConfigError(
      "MODEL_CAPABILITY_MISSING",
      `Model ${resolved.id} cannot run role '${role}': missing ${missing.join(", ")}. Choose another model or declare its capabilities in models.providers.`,
      { role, model: resolved.id, missing },
    );
  }
  return resolved;
}

/**
 * Creates the guard of an agent stage; its decisions go into the run's event log (REQ-VER-03, REQ-OBS-01).
 */
export function stageGuard(
  deps: AgentStageDeps,
  stage: string,
  role: AgentRoleDefinition,
  /** MCP tools of the stage (REQ-VER-03/AC3): allowed by name, `url` inputs checked against the allowlist. */
  mcp?: {
    readonly tools: readonly string[];
    readonly networkTools: readonly string[];
    readonly allowedOrigins: readonly string[];
  },
): Guard {
  const journal = createJournal(
    (line) => {
      const {
        event,
        stage: s,
        tool,
        code,
        reason,
        args,
        result,
      } = JSON.parse(line) as Record<string, unknown>;
      deps.events.emit(String(s), { kind: "agent", name: role.role }, String(event), {
        tool,
        code,
        reason,
        args,
        result,
      });
    },
    deps.now,
    deps.maskJson,
  );
  return createGuard({
    run: deps.ws.runId,
    stage,
    journal,
    policy: {
      workspaceRoot: deps.ws.dir,
      allowedTools: new Set([...role.tools.filter((t) => t !== "write_plan"), ...(mcp?.tools ?? [])]),
      writeTools: new Set(["write_file", "move_file", "delete_file", "write_plan"]),
      // REQ-PRJ-04/AC1: reads stay inside the run workspace, so nothing of another project is reachable.
      readTools: new Set(["read_file", "list_files", "search_code", "view_image"]),
      protectedPaths: DEFAULT_PROTECTED_PATHS,
      networkTools: new Set(mcp?.networkTools ?? []),
      allowedOrigins: mcp?.allowedOrigins ?? [],
    },
  });
}

/**
 * Without a tests repository no existing test can be cited (REQ-CTX-06/AC2): each claim of existing coverage becomes an
 * open question for the person reviewing, so the plan is not lost and no criterion goes untested without a decision
 * (approving needs --confirm-open-questions). A model kept citing the application's own tests (exploratory testing F26).
 */
function coverageAsQuestions(draft: PlanDraft, sources: SourceContext): PlanDraft {
  if (Object.keys(sources.tests ?? {}).length > 0 || draft.existing_coverage.length === 0) return draft;
  let next = Math.max(0, ...draft.open_questions.map((q) => Number(q.id.slice(1))));
  const asked = draft.existing_coverage.map((c) => ({
    id: `Q${String((next += 1))}`,
    question: `The planner considered ${c.covers.join(", ") || "part of the ticket"} covered by an existing test (${c.repo}:${c.file} "${c.title}") and wrote no case for it, but this run has no tests repository, so code cannot check that test. Add a case, or confirm the coverage.`,
    why: "existing coverage claimed without a tests repository",
  }));
  return { ...draft, existing_coverage: [], open_questions: [...draft.open_questions, ...asked] };
}

/** Sources that say what a result must be; exploration only says what is worth testing (REQ-PLAN-11/AC5). */
const EXPECTATION_SOURCES = new Set(["ac", "quote", "doc", "imported", "comment"]);

/**
 * REQ-PLAN-11/AC5+AC6, applied by code to the planner's answer: a case whose only grounds are exploration has no
 * source for its expected result, so it becomes an open question instead of an expectation copied from what the
 * application did; an accepted not-done item of exploration that no case covers becomes an open question too, so the
 * gap stays visible in the review.
 */
/** Whether a case's only grounds are exploration (no source for its expected result). */
const onlyExplored = (c: PlanDraft["cases"][number]): boolean =>
  c.source.some((s) => s.kind === "explore") && !c.source.some((s) => EXPECTATION_SOURCES.has(s.kind));

function explorationAsQuestions(draft: PlanDraft, context: ChangeContext): PlanDraft {
  let next = Math.max(0, ...draft.open_questions.map((q) => Number(q.id.slice(1))));
  const ask = (question: string, why: string) => ({ id: `Q${String((next += 1))}`, question, why });
  const ungrounded = draft.cases.filter(onlyExplored);
  const cases = draft.cases.filter((c) => !ungrounded.includes(c));
  const questions = ungrounded.map((c) =>
    ask(
      `${c.id} comes from exploration (${c.source
        .flatMap((s) => (s.kind === "explore" ? [`${s.session}/${s.item}`] : []))
        .join(
          ", ",
        )}) but no ticket criterion, quote, document or imported case says what its result must be; what the application did is not an expected result. What should it be?`,
      "a case from exploration without a source for its expected result",
    ),
  );
  const cited = new Set(
    cases.flatMap((c) => c.source.flatMap((s) => (s.kind === "explore" ? [`${s.session}/${s.item}`] : []))),
  );
  for (const e of context.explorations)
    for (const item of e.accepted ?? [])
      if (item.kind === "not-done" && !cited.has(`${e.session}/${item.id}`))
        questions.push(
          ask(
            `Exploration ${e.session} left "${item.title}" not done and a person accepted it as worth testing (${e.session}/${item.id}), but no case covers it: add a case, or decide it is out of scope.`,
            "an accepted not-done item of exploration without a case",
          ),
        );
  if (questions.length === 0) return draft;
  // The planner's validation keeps at least one grounded case, so `cases` is never empty here.
  return { ...draft, cases, open_questions: [...draft.open_questions, ...questions] };
}

/** Builds what sources are checked against from the change context. */
export function sourceContext(context: ChangeContext): SourceContext {
  return {
    ticket: context.ticket,
    diffs: Object.fromEntries(context.repos.map((r) => [r.alias, indexDiff(r.diff)])),
    comments: Object.fromEntries(context.repos.map((r) => [r.alias, r.comments])),
    tests: Object.fromEntries(context.testsRepos.map((t) => [t.alias, t.index.tests])),
    observations: Object.fromEntries(context.explorations.map((e) => [e.session, e.observations])),
    explored: Object.fromEntries(
      context.explorations.map((e) => [
        e.session,
        { items: e.items ?? [], accepted: (e.accepted ?? []).map((i) => i.id) },
      ]),
    ),
    docs: context.docs,
    imported: new Set(context.imported.map((c) => c.id)),
    map: mapAroundIds(context.mapAround),
  };
}

/** Tools and prompt section for the project's documentation, and how retrieved chunks are remembered. */
async function documentation(
  deps: AgentStageDeps,
  context: ChangeContext,
  stage: string,
  role: string,
): Promise<{ tools: AgentTool[]; fragments: ContextFragment[] }> {
  const access = deps.knowledge;
  if (!access) return { tools: [], fragments: [] };
  const remember = async (chunks: readonly KnowledgeChunk[]): Promise<void> => {
    for (const c of chunks) context.docs.set(c.id, c);
    await recordRunDocs(deps.ws.path("knowledge", "chunks.json"), chunks);
  };
  return {
    tools: createKnowledgeTools({
      access,
      stage,
      role,
      events: deps.events,
      now: deps.now,
      remember,
      wrap: contextOf(deps).wrap,
    }),
    fragments: await documentationFragments(access, remember, deps.now()),
  };
}

const issuesAsErrors = (issues: readonly { where: string; reason: string; source: unknown }[]): string[] =>
  issues.map((i) => `${i.where}: source ${JSON.stringify(i.source)} rejected: ${i.reason}`);

/**
 * Tokens the change's diffs may take in one call of a model (REQ-CTX-19/AC1): half of its budget, in estimated
 * tokens; the rest stays for the ticket, the documentation and the instructions. Undefined without a context profile.
 */
export function changeBudget(
  model: Partial<Pick<ResolvedModel, "context" | "inputLimit">>,
): number | undefined {
  if (!model.context) return undefined;
  return Math.floor((contextBudget(model.context, model.inputLimit?.limit) * 0.5) / model.context.margin);
}

/**
 * Groups of a change joined by meaning (REQ-CTX-20/AC4), per repository; empty without an embedding model or when it
 * fails, so the split is the code's alone.
 */
async function joinedGroups(deps: AgentStageDeps, context: ChangeContext): Promise<Map<string, string>> {
  const index = deps.semantic;
  if (!index) return new Map();
  const groups = changeGroups(context);
  const joined = new Map<string, string>();
  for (const repo of [...new Set(groups.map((g) => g.repo))])
    for (const [from, to] of await joinBySimilarity(
      index,
      groups.filter((g) => g.repo === repo),
    ).catch(() => new Map<string, string>()))
      joined.set(from, to);
  return joined;
}

/** One call of the analyst on a change or on one part of it (REQ-CTX-19/AC1). */
async function analyse(
  deps: AgentStageDeps,
  model: ResolvedModel,
  context: ChangeContext,
  sources: SourceContext,
  docs: { tools: AgentTool[]; fragments: ContextFragment[] },
  part?: ChangePart,
): Promise<{ value: Analysis; attempts: number; snapshot: string }> {
  const assembled = await assembleFor(deps, {
    stage: "analyze",
    role: "analyst",
    model,
    fragments: [
      instructions("analyst", ANALYST_SYSTEM),
      ...changeContextFragments(context, { ui: false, lessons: true }),
      ...docs.fragments,
      question(
        part
          ? `This change is too large for one call, so it is analysed in parts. Above is part ${part.id}: ${String(part.files.length)} file(s) of '${part.repo}'. Analyse only this part and answer with the JSON object; other parts are analysed separately.`
          : "Analyse this change and answer with the JSON object.",
      ),
    ],
  });
  const { value, attempts } = await runStructuredAgent({
    stage: "analyze",
    role: "analyst",
    model,
    context: assembled,
    schema: AnalysisSchema,
    validate: (analysis) => issuesAsErrors(checkAnalysisSources(analysis, sources)),
    tools: [
      ...createReadOnlyTools({ root: deps.ws.dir, mask: deps.maskText, wrap: contextOf(deps).wrap }),
      ...docs.tools,
    ],
    guard: stageGuard(deps, "analyze", roleDef("analyst")),
    usage: deps.usage,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  return { value, attempts, snapshot: assembled.snapshot.sha256 };
}

/**
 * Stage `analyze`: the analyst writes `analysis.json` (REQ-PLAN-01) with grounded claims. A change too large for the
 * analyst's budget is split by code and analysed in parts that code merges (REQ-CTX-19).
 *
 * @returns The validated analysis.
 */
export async function runAnalyst(deps: AgentStageDeps, context: ChangeContext): Promise<Analysis> {
  const model = await modelForRole(deps.models, "analyst");
  const actor = { kind: "agent", name: "analyst" } as const;
  deps.events.emit("analyze", actor, "stage.start", { model: model.id });
  const sources = sourceContext(context);
  const docs = await documentation(deps, context, "analyze", "analyst");
  const diffBudget = changeBudget(model);
  let raw: Analysis;
  let attempts: number;
  if (diffBudget === undefined || changeFits(context, diffBudget)) {
    ({ value: raw, attempts } = await analyse(deps, model, context, sources, docs));
  } else {
    // REQ-CTX-19: a change too large for one call is studied in parts, each in its own clean context; code merges.
    const joined = await joinedGroups(deps, context);
    const split = splitChange(context, diffBudget, joined);
    deps.events.emit("analyze", actor, "analyze.split", {
      diffBudget,
      ...(joined.size > 0 ? { joined: Object.fromEntries(joined), embedding: deps.semantic?.model } : {}),
      parts: split.parts.map((p) => p.part),
    });
    const done: { id: string; analysis: Analysis; snapshot: string }[] = [];
    attempts = 0;
    for (const { part, context: partContext } of split.parts) {
      const one = await analyse(deps, model, partContext, sources, docs, part);
      attempts += one.attempts;
      done.push({ id: part.id, analysis: one.value, snapshot: one.snapshot });
      deps.events.emit("analyze", actor, "analyze.part", {
        part: part.id,
        snapshot: one.snapshot,
        endpoints: one.value.endpoints.length,
        risks: one.value.risks.length,
      });
    }
    raw = mergeAnalyses(done);
    const issues = issuesAsErrors(checkAnalysisSources(raw, sources));
    if (issues.length > 0)
      throw new AgentOutputError(
        "ANALYSIS_MERGE_INVALID",
        "The merged analysis cites sources the change does not have.",
        {
          issues,
        },
      );
    await writeFile(
      deps.ws.path("analysis.parts.json"),
      `${JSON.stringify({ diffBudget, parts: split.parts.map((p, i) => ({ ...p.part, ...done[i] })) }, null, 2)}\n`,
      "utf8",
    );
  }
  const value = annotateDocSources(raw, context.docs, deps.knowledge?.maxAgeDays, deps.now());
  await writeFile(deps.ws.path("analysis.json"), `${JSON.stringify(value, null, 2)}\n`, "utf8");
  deps.events.emit("analyze", actor, "stage.end", {
    attempts,
    confidence: value.confidence,
    openQuestions: value.open_questions.length,
  });
  return value;
}

/** A revision request for an existing plan version (REQ-PLAN-04). */
export interface PlanRevision {
  readonly previous: Plan;
  readonly instruction: string;
  /** Asked by code, not by a person: the one automatic round for unverifiable expectations (REQ-PLAN-09/AC3). */
  readonly automatic?: boolean;
}

/**
 * Stage `plan`: the planner drafts a plan; code validates the schema and every source before it
 * is accepted (REQ-PLAN-02, REQ-PLAN-03). Returns the draft; storing a version is the caller's job.
 */
export async function runPlanner(
  deps: AgentStageDeps,
  context: ChangeContext,
  analysis: Analysis,
  revision?: PlanRevision,
): Promise<PlanDraft> {
  const role = roleDef("planner");
  const model = await modelForRole(deps.models, "planner");
  const actor = { kind: "agent", name: "planner" } as const;
  deps.events.emit("plan", actor, "stage.start", { model: model.id, revision: revision !== undefined });
  const sources = sourceContext(context);
  // REQ-PLAN-04: the version to revise is model output (data); the instruction comes from code or a person.
  const revisionFragments: ContextFragment[] = revision
    ? [
        fragment({
          kind: "plan",
          source: `plan.v${String(revision.previous.version)}`,
          trust: "untrusted",
          section: "varying",
          priority: 20,
          pinned: false,
          text: stringify({
            summary: revision.previous.summary,
            cases: revision.previous.cases,
            open_questions: revision.previous.open_questions,
            out_of_scope: revision.previous.out_of_scope,
          }),
        }),
        fragment({
          kind: "question",
          source: "revision",
          trust: "trusted",
          section: "varying",
          priority: 10,
          pinned: true,
          text: [
            `The data block plan.v${String(revision.previous.version)} above is the current plan (model output).`,
            revision.automatic === true
              ? "## Problems found by code (fix every one; keep everything else as it is)"
              : "## Reviewer instruction (from the human approver; follow it within the rules)",
            revision.instruction,
            "Return the complete revised plan.",
          ].join("\n"),
        }),
      ]
    : [];
  const docs = await documentation(deps, context, "plan", "planner");
  const diffBudget = changeBudget(model);
  const split = diffBudget !== undefined && !changeFits(context, diffBudget);
  const { value: raw, attempts } = await runStructuredAgent({
    stage: "plan",
    role: "planner",
    model,
    context: await assembleFor(deps, {
      stage: "plan",
      role: "planner",
      model,
      fragments: [
        instructions("planner", PLANNER_SYSTEM),
        // REQ-CTX-19/AC3: a change too large for one call reaches the planner through the merged analysis; its diffs
        // stay behind handles.
        ...changeContextFragments(context, { lessons: true }).map((f) =>
          f.kind === "diff" && split ? { ...f, onDemand: true } : f,
        ),
        ...docs.fragments,
        fragment({
          kind: "analysis",
          source: "analysis.json",
          trust: "untrusted",
          section: "varying",
          priority: 30,
          pinned: false,
          text: JSON.stringify(analysis, null, 2),
        }),
        ...revisionFragments,
        question("Write the test plan as the JSON object."),
      ],
    }),
    schema: PlanDraftSchema,
    normalize: (answer) => {
      const { value, filled } = fillMissingEvidence(answer);
      if (filled.length > 0) deps.events.emit("plan", actor, "plan.evidence_filled", { cases: filled });
      return value;
    },
    validate: (answer) => {
      const draft = coverageAsQuestions(answer, sources);
      const plan = PlanSchema.safeParse({ schema: 1, ticket: context.ticket.key, version: 1, ...draft });
      if (!plan.success)
        return plan.error.issues.map((i) => `${i.path.join(".")}: ${withPlacementHint(i.path, i.message)}`);
      // REQ-CTX-06/AC2: claimed existing coverage must name real tests of the tests repository.
      const errors = [
        ...issuesAsErrors(checkPlanSources(plan.data, sources)),
        ...checkExistingCoverage(plan.data, sources),
      ];
      // REQ-PLAN-11/AC5: a plan must keep at least one case grounded in the ticket, documents or imported cases.
      if (errors.length === 0 && plan.data.cases.every(onlyExplored))
        errors.push(
          "every case cites only exploration, which says what is worth testing but not what the result must be: ground the cases in the ticket's criteria ({kind: ac}), quotes or documents, and keep the exploration item as an extra source",
        );
      return errors;
    },
    tools: [
      ...createReadOnlyTools({ root: deps.ws.dir, mask: deps.maskText, wrap: contextOf(deps).wrap }),
      ...docs.tools,
    ],
    guard: stageGuard(deps, "plan", role),
    usage: deps.usage,
    ...(deps.signal ? { signal: deps.signal } : {}),
  });
  const value = annotateDocSources(
    explorationAsQuestions(coverageAsQuestions(raw, sources), context),
    context.docs,
    deps.knowledge?.maxAgeDays,
    deps.now(),
  );
  deps.events.emit("plan", actor, "stage.end", {
    attempts,
    cases: value.cases.length,
    openQuestions: value.open_questions.length,
  });
  // REQ-PLAN-09/AC3: expectations code cannot use (placeholders, wrong fields, unknown selectors, description-only
  // steps) go back to the planner once; what is still flagged afterwards is shown to the person reviewing.
  if (deps.planQuality && revision?.automatic !== true) {
    const asPlan = PlanSchema.parse({ schema: 1, ticket: context.ticket.key, version: 1, ...value });
    const flags = deps.planQuality(asPlan);
    if (flags.length > 0) {
      deps.events.emit("plan", actor, "plan.quality", { flags: flags.length, revising: true });
      return runPlanner(deps, context, analysis, {
        previous: asPlan,
        instruction: [
          "These expectations cannot be checked by a test. Use real values (numbers, texts), fields of the response,",
          "selectors and pages listed under 'Elements and pages in the code', and give every step something to compare:",
          formatPlanFlags(flags),
        ].join("\n"),
        automatic: true,
      });
    }
  }
  return value;
}
