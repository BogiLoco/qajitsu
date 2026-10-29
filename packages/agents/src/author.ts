import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fragment, type Analysis, type ContextFragment, type Plan, type TestCase } from "@qajitsu/core";
import {
  blockingProblems,
  checkSpecSource,
  formatSpecProblems,
  closestSelectors,
  renderUiInventory,
  renderUiSnapshot,
  snapshotSelectors,
  specSelectors,
  stepsWithoutActions,
  typecheckSpecs,
  unknownSelectors,
  type SpecCheckOptions,
  type SpecProblem,
} from "@qajitsu/verifier";
import { generateText, stepCountIs, type ModelMessage } from "ai";
import { guardTools } from "./loop.js";
import { openMcpTools } from "./mcp.js";
import { renderTestsRepo } from "./tests-repo.js";
import { modelExchange } from "./exchange.js";
import { callUsage } from "./usage.js";
import { prepareCall } from "./prepare-call.js";
import type { ChangeContext } from "./context.js";
import { assembleFor, instructions, modelForRole, stageGuard, type AgentStageDeps } from "./roles-run.js";
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
  A login form gets the account's secrets from the framework: ui.fillSecret(sel, "<account alias of the case>",
  "username" | "password" | "totp") (totp: the authenticator's current code); a code sent by e-mail or SMS in a step
  whose expect has "message" is typed with ui.fillCode(sel). Never type a password, token or code yourself.
- Web cases also have: ui.hover(sel), ui.dblclick(sel), ui.rightClick(sel), ui.dragTo(sel, targetSel),
  ui.dragBy(sel, dx, dy), ui.keys("Control+A"), ui.scrollTo(sel), ui.scrollBy(dx, dy), ui.scrollUntil(sel) for
  infinite lists; ui.upload(sel, "<file key>", ...) with the keys of the case's "files" in the plan (never a path or
  content); ui.download(sel) clicks and keeps the file, checked with
  verify("<step id>", "download.<name|type|size|sha256|rows|texts.<n>|fields.<key>>", undefined, plan.expect(...))
  in the same step; ui.switchToNewPage() after the action that opened a pop-up or tab, ui.switchToOpener() and
  ui.closePage() to go back. Elements inside iframes: "frame:<selector of the iframe> >> <selector>", for example
  "frame:title:Payment >> testid:iban-field". When a selector matches several elements, narrow it with a chain:
  "role:row >> has-text:Anna Smith >> role:button:Delete" or "testid:card >> nth:2" (1 is the first).
  A step whose expect has "state" reads the application's test hook:
  verify("<step id>", "state.<path>", undefined, plan.expect("<case>.<step>.state.<path>")).
  ui.advanceTime(seconds) moves the page's clock forward (countdowns, offers that end); ui.setOffline(true) cuts the
  network and ui.setOffline(false) brings it back (offline pages, queued actions and their sync). A step whose expect
  has "manifest" checks the installable app:
  verify("<step id>", "manifest.<name|short_name|start_url|display|icons|controlled>", undefined, plan.expect(...)).
  A step whose expect has "websocket" checks the page's socket messages after the action that causes them:
  verify("<step id>", "websocket.<received|sent>.<n>", undefined, plan.expect(...)).
  These are web only.
- Touch gestures (web on a phone, native apps): ui.tap(sel), ui.doubleTap(sel), ui.longPress(sel, seconds),
  ui.swipe(sel or "screen", "left" | "right" | "up" | "down", { distance: 0.6, speed: "normal" }), ui.pinch(sel or
  "screen", "in" | "out"), ui.pullToRefresh(); in native apps ui.scrollUntil(sel) swipes until the element shows.
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
  /** Why a person sent the previous spec of a case back (REQ-VER-24/AC3), by case id. */
  reviewNotes?: ReadonlyMap<string, string>,
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
      const at = (
        over: Omit<Parameters<typeof fragment>[0], "section" | "pinned"> & { pinned?: boolean },
      ): ContextFragment => fragment({ section: "varying", pinned: false, ...over });
      // REQ-CTX-12: the case's input as fragments; the approved case is trusted and pinned, the rest is data.
      const input = assembleFor(deps, {
        stage: "author",
        role: "author",
        model: model.id,
        fragments: [
          instructions("author", AUTHOR_SYSTEM),
          at({
            kind: "question",
            source: "task",
            trust: "trusted",
            priority: 95,
            pinned: true,
            text: [
              `Write the spec for ${planCase.id}.`,
              // The reason comes from the QA person running QAJitsu, not from a ticket or code: an instruction to
              // follow (REQ-VER-24/AC3). It is masked before it is stored and sent.
              ...(reviewNotes?.has(planCase.id)
                ? [
                    "## A reviewer sent your previous spec of this case back; fix exactly this",
                    reviewNotes.get(planCase.id) ?? "",
                  ]
                : []),
              `Account aliases available: ${accounts.length > 0 ? accounts.join(", ") : "(none: call api without as())"}.`,
              `Code of the change is under ${context.repos.map((r) => `repos/${r.alias}/`).join(", ") || "repos/"}.`,
            ].join("\n\n"),
          }),
          at({
            kind: "plan",
            source: `plan/${planCase.id}`,
            trust: "trusted",
            priority: 80,
            pinned: true,
            text: `## Approved case (from the plan; expectations are read with plan.expect)\n${describeCase(planCase)}`,
          }),
          at({
            kind: "analysis",
            source: "analysis.endpoints",
            trust: "untrusted",
            priority: 60,
            text: JSON.stringify(analysis.endpoints.map((e) => ({ method: e.method, path: e.path }))),
          }),
          // REQ-PLAN-09/AC7: the element ids and pages the code defines, so the spec opens real pages.
          ...(context.ui
            ? [
                at({
                  kind: "ui",
                  source: "ui/inventory",
                  trust: "untrusted",
                  priority: 50,
                  text: renderUiInventory(context.ui),
                }),
              ]
            : []),
          // REQ-EXEC-22/AC1+AC2: what the running application shows on the case's platform, masked by the caller.
          ...(screensFor(planCase.type).length > 0
            ? [
                at({
                  kind: "ui",
                  source: "ui/snapshot",
                  trust: "untrusted",
                  priority: 49,
                  text: renderUiSnapshot(screensFor(planCase.type)),
                }),
              ]
            : []),
          ...context.testsRepos.flatMap((t) => [
            at({
              kind: "repository",
              source: `tests/${t.alias}`,
              trust: "trusted",
              priority: 45,
              text: `## Conventions of the tests repository '${t.alias}' (REQ-EXEC-01/AC3; code under repos/${t.alias}/)`,
            }),
            at({
              kind: "repository",
              source: `tests/${t.alias}/index`,
              trust: "untrusted",
              priority: 45,
              text: renderTestsRepo(t.alias, t.index),
            }),
          ]),
        ],
      });
      let messages: ModelMessage[] = [{ role: "user", content: input.prompt }];
      let problems: SpecProblem[] = [];
      // Every problem of every rejected answer, for the agent scorecard (REQ-LLM-14/AC2).
      const rejected: SpecProblem[] = [];
      let file: string | undefined;
      let attempts = 0;
      let askedAboutSelectors = false;
      for (let attempt = 1; attempt <= AUTHOR_MAX_ATTEMPTS; attempt += 1) {
        attempts += 1;
        const startedAt = Date.now();
        const result = await generateText({
          model: model.model,
          ...prepareCall(model, input, messages),
          ...(tools ? { tools, stopWhen: stepCountIs(10) } : {}),
          ...(deps.signal ? { abortSignal: deps.signal } : {}),
          maxRetries: 2,
        });
        deps.usage.record(
          "author",
          "author",
          model.id,
          model.profile,
          callUsage(result.usage, startedAt),
          modelExchange("author", "author", model, { system: input.system, messages }, result),
        );
        const code = extractCode(result.text);
        problems =
          code === undefined
            ? [{ check: "lint", message: "answer contained no ```ts code block" }]
            : await checkSpec(code, planCase.id, plan, deps.specChecks);
        rejected.push(...problems);
        // REQ-EXEC-22/AC3: selectors that match nothing recorded go back to the author once, with the closest ones;
        // the question does not use up an attempt, and the answer is accepted when it passes the checks.
        const ask = code !== undefined && problems.length === 0 && !askedAboutSelectors;
        const unknown = ask
          ? unknownSelectors(specSelectors(code), planCase.type, {
              screens: screensFor(planCase.type),
              inventory: context.ui,
            })
          : [];
        // REQ-EXEC-01: a UI step that only verifies checks a state nobody produced; its plan action says what to do.
        const idle =
          ask && planCase.type !== "api"
            ? stepsWithoutActions(code).flatMap((id) => {
                const s = planCase.steps.find((x) => x.id === id);
                return s && s.manual !== true ? [s] : [];
              })
            : [];
        if (code !== undefined && (unknown.length > 0 || idle.length > 0)) {
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
                ...(unknown.length > 0
                  ? [
                      "These selectors match no element of the recorded pages or screens and no element id in the code:",
                      ...unknown.map(
                        (s) =>
                          `- ${s} (closest recorded: ${closestSelectors(s, known).join(", ") || "none"})`,
                      ),
                      "Use a recorded selector instead. Keep one only if its element appears after an action of the spec.",
                    ]
                  : []),
                ...(idle.length > 0
                  ? [
                      "These steps only verify; they perform no action, so they check a state nobody produced:",
                      ...idle.map((s) => `- step("${s.id}"): the plan says "${s.action}"`),
                      "Perform that action through ui in the step before its verify() (tap or fill the elements that do it). Keep a step without action only if its action needs nothing.",
                    ]
                  : []),
                "Answer with the complete spec.",
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
      const findings: Record<string, number> = {};
      const rules: Record<string, number> = {};
      for (const p of rejected) {
        findings[p.check] = (findings[p.check] ?? 0) + 1;
        const rule = p.check === "quality" ? /^([a-z-]+):/.exec(p.message)?.[1] : undefined;
        if (rule) rules[rule] = (rules[rule] ?? 0) + 1;
      }
      deps.events.emit("author", actor, "case.end", {
        caseId: planCase.id,
        attempts,
        ok: file !== undefined,
        problems: problems.length,
        // REQ-LLM-14/AC2: what the checks and the quality gate rejected, by check and by quality rule.
        ...(rejected.length > 0 ? { findings, ...(Object.keys(rules).length > 0 ? { rules } : {}) } : {}),
      });
      out.push({ caseId: planCase.id, ...(file ? { file } : {}), attempts, problems: file ? [] : problems });
    }
    return out;
  } finally {
    await mcp?.close();
    if (scratch !== undefined) await rm(scratch, { recursive: true, force: true });
  }
}
