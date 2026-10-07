import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Analysis, Plan, TestCase } from "@qajitsu/core";
import {
  blockingProblems,
  checkSpecSource,
  formatSpecProblems,
  typecheckSpecs,
  type SpecProblem,
} from "@qajitsu/verifier";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { guardTools } from "./loop.js";
import { openMcpTools } from "./mcp.js";
import { renderTestsRepo } from "./tests-repo.js";
import { untrusted, UNTRUSTED_DATA_RULES, type ChangeContext } from "./context.js";
import { modelForRole, stageGuard, type AgentStageDeps } from "./roles-run.js";
import { AGENT_ROLES } from "./roles.js";
import { createReadOnlyTools } from "./workspace-tools.js";

/** Attempts the author gets per case before the case is BLOCKED (REQ-EXEC-03/AC4). */
export const AUTHOR_MAX_ATTEMPTS = 2;

/** Example spec shown to the author: the shape every spec must follow. */
export const EXAMPLE_SPEC = `import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-07";

export async function run({ step, verify, plan, api }: CaseContext): Promise<void> {
  const user = api.as("user:standard");
  await step("S1", async () => {
    await user.post("/items", { name: "x", quantity: 2 });
    const res = await user.get("/items/x");
    verify("S1", "status", res.status, plan.expect("TC-07.S1.status"));
    verify("S1", "fields.quantity", res.json("quantity"), plan.expect("TC-07.S1.fields.quantity"));
  });
}
`;

/** System prompt of the author role (REQ-EXEC-01). */
export const AUTHOR_SYSTEM = `You are the test author of QAJitsu. You write one executable TypeScript spec for one approved test case.
${UNTRUSTED_DATA_RULES}
Rules (checked by code; a violating spec is rejected):
- Start with: import type { CaseContext } from "@qajitsu/steps"; no other imports, no dynamic import.
- Export const caseId = "<case id>" and export async function run({ step, verify, plan, api, inbox }: CaseContext) (take only what you use).
- One step("<step id>", async () => { ... }) per plan step, in order; API calls only inside steps through api or api.as("<account alias>").
- Every step has at least one verify("<step id>", "<field>", <actual value>, plan.expect("<case>.<step>.<field>")).
  Fields are "status", "fields.<key>" (read with res.json("<key>")) or "texts.<n>". The expected value is ALWAYS plan.expect(...) with exactly the same step and field; never a literal.
- A step whose expect has "message": use const email = await inbox.address() (or inbox.address("url") for a webhook)
  as the address in the test data, then const msg = await inbox.wait("<step id>") and
  verify("<step id>", "message", msg, plan.expect("<case>.<step>.message")); msg.links holds the links of the message.
- A step with "manual": true is performed by a person: write step("<step id>", () => {}) with an empty body and no
  verify(); QAJitsu pauses there and asks the tester.
- Never use process, fetch, require, eval, globalThis or timers. Never write files.
- Use the read-only tools to look up endpoints, payloads and field names in the code under repos/.
- When the tests repository's conventions are given, follow them: use its preferred selector strategy and the same
  selectors and flows as its page objects and helpers (read them under repos/<tests repo>/). Specs cannot import them;
  copy the selector, never the code.
Answer with the complete spec in one \`\`\`ts code block and nothing else.
Example:
\`\`\`ts
${EXAMPLE_SPEC}\`\`\``;

/** Outcome of authoring one case. */
export interface AuthoredSpec {
  readonly caseId: string;
  readonly file?: string;
  readonly attempts: number;
  /** Problems of the last attempt when no valid spec was produced (the case is BLOCKED). */
  readonly problems: readonly SpecProblem[];
}

/** Extracts the TypeScript code block of an answer. */
export function extractCode(text: string): string | undefined {
  const m = /```(?:ts|typescript)?\s*\n([\s\S]*?)```/.exec(text);
  return m?.[1]?.trim() ? `${m[1].trim()}\n` : undefined;
}

const describeCase = (c: TestCase): string =>
  JSON.stringify(
    { id: c.id, title: c.title, preconditions: c.preconditions, data: c.data, steps: c.steps },
    null,
    2,
  );

/**
 * Checks a spec source the same way `qj run` does before execution (REQ-EXEC-03/AC1..AC3).
 *
 * @returns Every problem found; empty when the spec may run.
 */
export async function checkSpec(source: string, caseId: string, plan: Plan): Promise<SpecProblem[]> {
  const problems = blockingProblems(checkSpecSource(source, caseId, plan));
  if (problems.length > 0) return problems;
  const dir = await mkdtemp(join(tmpdir(), "qj-spec-"));
  try {
    const file = join(dir, `${caseId}.spec.ts`);
    await writeFile(file, source, "utf8");
    return typecheckSpecs([file]).get(file) ?? [];
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Stage `author`: writes `specs/<case>.spec.ts` for every approved case without a valid spec
 * (REQ-EXEC-01). The model only proposes code; QAJitsu checks it and writes the file, so the author
 * never touches results, evidence or the plan (invariant 2).
 *
 * @param deps - Stage ports.
 * @param plan - Approved plan.
 * @param context - Change context (for endpoints and payloads).
 * @param analysis - Analyst output.
 * @param accounts - Account aliases available in the environment.
 */
export async function runAuthor(
  deps: AgentStageDeps,
  plan: Plan,
  context: ChangeContext,
  analysis: Analysis,
  accounts: readonly string[],
): Promise<AuthoredSpec[]> {
  const role = AGENT_ROLES.find((r) => r.role === "author");
  if (!role) throw new Error("author role missing");
  const model = await modelForRole(deps.models, "author");
  const actor = { kind: "agent", name: "author" } as const;
  // REQ-EXEC-01/AC2: MCP exploration tools, guarded like every other tool (REQ-VER-03/AC3); never test execution.
  const scratch = deps.mcp && model.profile.tools ? await mkdtemp(join(tmpdir(), "qj-mcp-")) : undefined;
  const mcp =
    deps.mcp && scratch !== undefined
      ? await openMcpTools({
          servers: deps.mcp.servers,
          role: "author",
          allowedOrigins: deps.mcp.allowedOrigins,
          cwd: scratch,
          mask: deps.maskText,
          ...(deps.mcp.connect ? { connect: deps.mcp.connect } : {}),
        })
      : undefined;
  for (const u of mcp?.unavailable ?? []) deps.events.emit("author", actor, "mcp.unavailable", u);
  const guard = stageGuard(
    deps,
    "author",
    role,
    mcp && deps.mcp
      ? {
          tools: mcp.tools.map((t) => t.name),
          networkTools: mcp.networkTools,
          allowedOrigins: deps.mcp.allowedOrigins,
        }
      : undefined,
  );
  const tools = model.profile.tools
    ? guardTools(
        [...createReadOnlyTools({ root: deps.ws.dir, mask: deps.maskText }), ...(mcp?.tools ?? [])],
        guard,
        deps.signal,
      )
    : undefined;
  try {
    const out: AuthoredSpec[] = [];
    for (const planCase of plan.cases) {
      deps.events.emit("author", actor, "case.start", { caseId: planCase.id, model: model.id });
      let messages: ModelMessage[] = [
        {
          role: "user",
          content: [
            `Write the spec for ${planCase.id}.`,
            `Account aliases available: ${accounts.length > 0 ? accounts.join(", ") : "(none: call api without as())"}.`,
            "## Approved case (from the plan; expectations are read with plan.expect)",
            untrusted(`plan.${planCase.id}`, describeCase(planCase)),
            "## Endpoints found by the analyst",
            untrusted(
              "analysis.endpoints",
              JSON.stringify(analysis.endpoints.map((e) => ({ method: e.method, path: e.path }))),
            ),
            `Code of the change is under ${context.repos.map((r) => `repos/${r.alias}/`).join(", ") || "repos/"}.`,
            ...context.testsRepos.flatMap((t) => [
              `## Conventions of the tests repository '${t.alias}' (REQ-EXEC-01/AC3; code under repos/${t.alias}/)`,
              renderTestsRepo(t.alias, t.index),
            ]),
          ].join("\n\n"),
        },
      ];
      let problems: SpecProblem[] = [];
      let file: string | undefined;
      let attempts = 0;
      for (let attempt = 1; attempt <= AUTHOR_MAX_ATTEMPTS; attempt += 1) {
        attempts = attempt;
        const result = await generateText({
          model: model.model,
          system: AUTHOR_SYSTEM,
          messages,
          ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
          ...(deps.signal ? { abortSignal: deps.signal } : {}),
          maxRetries: 2,
        });
        deps.usage.record("author", "author", model.id, model.profile, {
          inputTokens: result.usage.inputTokens ?? 0,
          outputTokens: result.usage.outputTokens ?? 0,
        });
        const code = extractCode(result.text);
        problems =
          code === undefined
            ? [{ check: "lint", message: "answer contained no ```ts code block" }]
            : await checkSpec(code, planCase.id, plan);
        if (code !== undefined && problems.length === 0) {
          file = deps.ws.path("specs", `${planCase.id}.spec.ts`);
          await writeFile(file, code, "utf8");
          break;
        }
        messages = [
          ...messages,
          ...result.responseMessages,
          {
            role: "user",
            content: `The spec was rejected (attempt ${String(attempt)} of ${String(AUTHOR_MAX_ATTEMPTS)}). Fix these problems and answer with the complete spec:\n${formatSpecProblems(problems)}`,
          },
        ];
      }
      deps.events.emit("author", actor, "case.end", {
        caseId: planCase.id,
        attempts,
        ok: file !== undefined,
        problems: problems.length,
      });
      out.push({ caseId: planCase.id, ...(file ? { file } : {}), attempts, problems: file ? [] : problems });
    }
    return out;
  } finally {
    await mcp?.close();
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}
