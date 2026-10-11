import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Analysis, Plan, TestCase } from "@qajitsu/core";
import {
  blockingProblems,
  checkSpecSource,
  formatSpecProblems,
  closestSelectors,
  renderUiInventory,
  renderUiSnapshot,
  snapshotSelectors,
  specSelectors,
  typecheckSpecs,
  unknownSelectors,
  type SpecCheckOptions,
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

/** Example web spec shown to the author: the browser is driven through `ui`, element states are read by QAJitsu. */
export const EXAMPLE_WEB_SPEC = `import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-08";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.as("user:standard");
    await ui.goto("/orders/new");
    verify("S1", "elements.testid:submit-order.enabled", undefined, plan.expect("TC-08.S1.elements.testid:submit-order.enabled"));
  });
  await step("S2", async () => {
    await ui.check("role:checkbox:I agree to the terms");
    verify("S2", "elements.testid:submit-order.enabled", undefined, plan.expect("TC-08.S2.elements.testid:submit-order.enabled"));
    verify("S2", "texts.0", undefined, plan.expect("TC-08.S2.texts.0"));
  });
}
`;

/** Example mobile spec shown to the author: a native app is driven by tapping its elements; no web session. */
export const EXAMPLE_MOBILE_SPEC = `import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-09";

export async function run({ step, verify, plan, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.click("testid:basket-add");
    verify("S1", "elements.testid:basket-count.text", undefined, plan.expect("TC-09.S1.elements.testid:basket-count.text"));
  });
  await step("S2", async () => {
    await ui.click("text:Summary");
    await ui.back();
    await ui.waitFor("testid:basket-count");
    verify("S2", "elements.testid:basket-count.text", undefined, plan.expect("TC-09.S2.elements.testid:basket-count.text"));
  });
}
`;

/** System prompt of the author role (REQ-EXEC-01). */
export const AUTHOR_SYSTEM = `You are the test author of QAJitsu. You write one executable TypeScript spec for one approved test case.
${UNTRUSTED_DATA_RULES}
Rules (checked by code; a violating spec is rejected):
- Start with: import type { CaseContext } from "@qajitsu/steps"; no other imports, no dynamic import.
- Export const caseId = "<case id>" and export async function run({ step, verify, plan, api, ui, inbox }: CaseContext) (take only what you use).
- One step("<step id>", async () => { ... }) per plan step, in order; API calls only inside steps through api or api.as("<account alias>").
- Every verify("<step id>", ...) is written inside the function of that same step, never after it or in another step.
- Every step has at least one verify("<step id>", "<field>", <actual value>, plan.expect("<case>.<step>.<field>")).
  Fields are "status", "fields.<key>" (read with res.json("<key>")) or "texts.<n>". The expected value is ALWAYS plan.expect(...) with exactly the same step and field; never a literal.
- Web and mobile steps drive the app only through ui, inside the step: await ui.as("<account alias>") opens it as an
  account, then ui.goto("/path"), ui.click(sel), ui.fill(sel, text), ui.check(sel), ui.uncheck(sel), ui.select(sel,
  value), ui.press(sel, key), ui.waitFor(sel), ui.back(). Open the page before checking anything on it.
- Selectors, the most stable first: testid:<id> (the project's test id; in a native app the accessibility id, on
  Android also the resource id), role:<role>:<accessible name>, label:<text>, placeholder:<text>, alt:<text>,
  title:<text>, text:<visible text>, id:<id>; css:<selector> (web) and xpath:<path> (native app) only as the last
  resort. A native app has testid:, label:, text:, id: and xpath: only. Use the plan's selectors for expectations and
  the ones listed under "What the application shows" for actions; when the code has no test ids, use roles, labels
  and texts.
- Mobile cases (type "mobile") test a native app that is already open: never ui.as (a native app cannot get a web
  session; log in through its own screens when the plan says so) and ui.goto only for deep links; perform every
  action of the step by tapping its elements (ui.click, ui.fill), ui.back() presses the Android back button.
- QAJitsu reads web and mobile values from the live page: element states are verified as
  verify("<step id>", "elements.<selector>.<property>", undefined, plan.expect("<case>.<step>.elements.<selector>.<property>"))
  and visible texts as verify("<step id>", "texts.<n>", undefined, plan.expect("<case>.<step>.texts.<n>")).
- A step whose expect has "message": use const email = await inbox.address() (or inbox.address("url") for a webhook)
  as the address in the test data, then const msg = await inbox.wait("<step id>") and
  verify("<step id>", "message", msg, plan.expect("<case>.<step>.message")); msg.links holds the links of the message.
- A step whose expect has "visual": once the page shows the state to compare, call
  verify("<step id>", "visual", undefined, plan.expect("<case>.<step>.visual")); QAJitsu takes and compares the screenshot.
- A step with "manual": true is performed by a person: write step("<step id>", () => {}) with an empty body and no
  verify(); QAJitsu pauses there and asks the tester.
- Never use process, fetch, require, eval, globalThis or timers. Never write files.
- Use the read-only tools to look up endpoints, payloads and field names in the code under repos/.
- When the tests repository's conventions are given, follow them: use its preferred selector strategy and the same
  selectors and flows as its page objects and helpers (read them under repos/<tests repo>/). Specs cannot import them;
  copy the selector, never the code.
Answer with the complete spec in one \`\`\`ts code block and nothing else.
Example (API):
\`\`\`ts
${EXAMPLE_SPEC}\`\`\`
Example (web):
\`\`\`ts
${EXAMPLE_WEB_SPEC}\`\`\`
Example (mobile):
\`\`\`ts
${EXAMPLE_MOBILE_SPEC}\`\`\``;

/** Outcome of authoring one case. */
export interface AuthoredSpec {
  readonly caseId: string;
  readonly file?: string;
  readonly attempts: number;
  /** Problems of the last attempt when no valid spec was produced (the case is BLOCKED). */
  readonly problems: readonly SpecProblem[];
  /** Why the case was not written at all, e.g. the run's budget was reached (the case is NOT_RUN). */
  readonly skipped?: string;
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
 * @param options - Project-dependent options, e.g. whether the native app has deep links.
 * @returns Every problem found; empty when the spec may run.
 */
export async function checkSpec(
  source: string,
  caseId: string,
  plan: Plan,
  options: SpecCheckOptions = {},
): Promise<SpecProblem[]> {
  const problems = blockingProblems(checkSpecSource(source, caseId, plan, options));
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
  /** Checked before each case; a reason stops writing further specs (REQ-PLAN-08/AC3). */
  stopReason?: () => string | undefined,
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
    const screensFor = (type: string) =>
      (context.snapshot ?? []).filter((s) =>
        type === "web" ? s.platform === "web" : type === "mobile" && s.platform !== "web",
      );
    for (const planCase of plan.cases) {
      const stop = stopReason?.();
      if (stop !== undefined) {
        deps.events.emit("author", actor, "case.skipped", { caseId: planCase.id, reason: stop });
        out.push({ caseId: planCase.id, attempts: 0, problems: [], skipped: stop });
        continue;
      }
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
            // REQ-PLAN-09/AC7: the element ids and pages the code defines, so the spec opens real pages.
            ...(context.ui ? [untrusted("ui/inventory", renderUiInventory(context.ui))] : []),
            // REQ-EXEC-22/AC1+AC2: what the running application shows on the case's platform, masked by the caller.
            ...(screensFor(planCase.type).length > 0
              ? [untrusted("ui/snapshot", renderUiSnapshot(screensFor(planCase.type)))]
              : []),
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
      let askedAboutSelectors = false;
      for (let attempt = 1; attempt <= AUTHOR_MAX_ATTEMPTS; attempt += 1) {
        attempts += 1;
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
            : await checkSpec(code, planCase.id, plan, deps.specChecks);
        // REQ-EXEC-22/AC3: selectors that match nothing recorded go back to the author once, with the closest ones;
        // the question does not use up an attempt, and the answer is accepted when it passes the checks.
        const unknown =
          code !== undefined && problems.length === 0 && !askedAboutSelectors
            ? unknownSelectors(specSelectors(code), planCase.type, {
                screens: screensFor(planCase.type),
                inventory: context.ui,
              })
            : [];
        if (code !== undefined && unknown.length > 0) {
          askedAboutSelectors = true;
          const known = snapshotSelectors(
            screensFor(planCase.type),
            planCase.type === "web" ? ["web"] : ["android", "ios"],
          );
          deps.events.emit("author", actor, "selectors.unknown", {
            caseId: planCase.id,
            selectors: unknown.length,
          });
          messages = [
            ...messages,
            ...result.responseMessages,
            {
              role: "user",
              content: [
                "These selectors match no element of the recorded pages or screens and no element id in the code:",
                ...unknown.map(
                  (s) => `- ${s} (closest recorded: ${closestSelectors(s, known).join(", ") || "none"})`,
                ),
                "Use a recorded selector instead. Keep one only if its element appears after an action of the spec. Answer with the complete spec.",
              ].join("\n"),
            },
          ];
          attempt -= 1;
          continue;
        }
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
