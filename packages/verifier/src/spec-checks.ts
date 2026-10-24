import { existsSync, statSync } from "node:fs";
import { plannedFields } from "./expectations.js";
import { checkSpecQuality } from "./spec-quality.js";
import { dirname, join } from "node:path";
import type { Plan } from "@qajitsu/core";
import ts from "typescript";

/** One problem found in a generated spec. */
export interface SpecProblem {
  /** `review` findings are reported but do not block execution (e.g. CSS selectors, REQ-EXEC-05/AC2). */
  readonly check: "typecheck" | "lint" | "coverage" | "assertion-lock" | "quality" | "review";
  readonly message: string;
  readonly line?: number;
}

const FORBIDDEN_GLOBALS = new Set([
  "process",
  "require",
  "fetch",
  "eval",
  "Function",
  "globalThis",
  "global",
  "XMLHttpRequest",
  "WebSocket",
  "Deno",
  "Bun",
  "setInterval",
]);

const UI_ACTIONS = new Set([
  "click",
  "fill",
  "check",
  "uncheck",
  "select",
  "press",
  "waitFor",
  // REQ-EXEC-38..40 (ADR-0013): web actions whose first argument is a selector.
  "hover",
  "dblclick",
  "rightClick",
  "dragTo",
  "dragBy",
  "scrollTo",
  "scrollUntil",
  "upload",
  "download",
]);

/** Web actions a native app does not offer yet (mobile gestures come with REQ-EXEC-41). */
const WEB_ONLY = [
  "hover",
  "dblclick",
  "rightClick",
  "dragTo",
  "dragBy",
  "keys",
  "scrollTo",
  "scrollBy",
  "scrollUntil",
  "upload",
  "download",
  "switchToNewPage",
  "switchToOpener",
  "closePage",
];

/** Selector kinds a native app can resolve (REQ-EXEC-06, REQ-EXEC-21/AC3); `role:` and `css:` exist only in a browser. */
const NATIVE_SELECTORS = ["testid:", "label:", "text:", "id:", "xpath:"];

/** Selector kinds a browser can resolve (REQ-EXEC-21/AC3). */
const WEB_SELECTORS = [
  "testid:",
  "role:",
  "label:",
  "placeholder:",
  "alt:",
  "title:",
  "text:",
  "id:",
  "css:",
  // REQ-EXEC-39/AC1: an element inside (nested) iframes.
  "frame:",
];

/** `ui` operations that do not exist in a native app, and what to do instead (REQ-EXEC-06). */
const NATIVE_UNAVAILABLE: Readonly<Record<string, string>> = {
  as: "ui.as() does not exist in a native app: log in through the app's own screens with ui.fill and ui.click",
  select: "ui.select() does not exist in a native app: tap the option with ui.click",
  ...Object.fromEntries(
    WEB_ONLY.map((name) => [name, `ui.${name}() is not available in native apps yet: it works in web cases`]),
  ),
};

/** Options of the static checks that depend on the project. */
export interface SpecCheckOptions {
  /** The native app declares `mobile.deep_link_scheme`, so `ui.goto()` may open a deep link in mobile cases. */
  readonly deepLinks?: boolean;
}

const FORBIDDEN_MEMBERS = new Set([
  "constructor",
  "prototype",
  "__proto__",
  "defineProperty",
  "setPrototypeOf",
  "getPrototypeOf",
  "__defineGetter__",
  "__defineSetter__",
  "call",
  "apply",
  "bind",
]);

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

const calleeName = (call: ts.CallExpression): string | undefined => {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return undefined;
};

/** The id of the step whose function (`step("S1", async () => ...)`) contains a node, if any. */
const enclosingStep = (node: ts.Node): string | undefined => {
  for (let n = node.parent; !ts.isSourceFile(n); n = n.parent) {
    if (!(ts.isArrowFunction(n) || ts.isFunctionExpression(n))) continue;
    const call = n.parent;
    if (ts.isCallExpression(call) && calleeName(call) === "step" && call.arguments[1] === n) {
      const id = call.arguments[0];
      return id !== undefined && ts.isStringLiteral(id) ? id.text : undefined;
    }
  }
  return undefined;
};

/**
 * The element selectors a spec uses (REQ-EXEC-22/AC3): the first argument of every `ui.*` action and the selector of
 * every `verify(..., "elements.<selector>.<property>", ...)`, in the order they appear.
 *
 * @param source - Spec source.
 */
export function specSelectors(source: string): string[] {
  const sf = ts.createSourceFile("spec.ts", source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const [first, second] = node.arguments;
      const onUi =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "ui";
      if (onUi && name !== undefined && UI_ACTIONS.has(name) && first && ts.isStringLiteral(first))
        out.push(first.text);
      if (name === "verify" && second && ts.isStringLiteral(second)) {
        const m = /^elements\.(.+)\.(?:visible|enabled|checked|text|value)$/.exec(second.text);
        if (m?.[1] !== undefined) out.push(m[1]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/**
 * Steps of a spec that do nothing but verify: no `ui.*` and no API call inside their function (REQ-EXEC-01). A step
 * whose plan action changes the application then checks a state nobody produced.
 *
 * @param source - Spec source.
 * @returns Step ids, in the order they appear.
 */
export function stepsWithoutActions(source: string): string[] {
  const sf = ts.createSourceFile("spec.ts", source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const out: string[] = [];
  const acts = (node: ts.Node): boolean => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const target = node.expression.expression;
      const root =
        ts.isCallExpression(target) && ts.isPropertyAccessExpression(target.expression)
          ? target.expression.expression
          : target;
      if (ts.isIdentifier(root) && root.text !== "plan" && calleeName(node) !== "expect") return true;
    }
    return ts.forEachChild(node, acts) === true;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && calleeName(node) === "step") {
      const [id, fn] = node.arguments;
      if (id && ts.isStringLiteral(id) && fn && !acts(fn)) out.push(id.text);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** Requests of the api client; called on `api` itself they go out without any login. */
const HTTP_VERBS = new Set(["get", "post", "put", "patch", "delete"]);

/**
 * Lint, plan coverage and assertion lock of one spec (REQ-EXEC-03/AC1..AC3, invariant 4). Pure AST
 * checks, no execution:
 * - only `import type` from `@qajitsu/steps`; no dynamic import, no `process`, `require`, `fetch`,
 *   `eval`, `globalThis` (the spec cannot reach files, secrets or the network except through `api`);
 * - exports `caseId` equal to the case and `run`;
 * - every plan step has exactly one `step("Sx")` and at least one `verify("Sx", ...)`; a manual step
 *   (REQ-EXEC-11) has its `step("Sx", () => {})` and no `verify()`;
 * - every `verify()` has 4 arguments and the 4th is `plan.expect("<case>.<step>.<field>")` with the
 *   same step and field as the call, so expected values always come from the approved plan;
 * - a mobile case uses only what a native app offers: no `ui.as()` or `ui.select()`, `ui.goto()` only with a deep
 *   link scheme, and `testid:`, `label:` or `text:` selectors (the device would refuse the rest at run time).
 *
 * @param source - Spec source.
 * @param caseId - Case the spec must implement.
 * @param plan - Approved plan.
 * @param options - Project-dependent options.
 */
export function checkSpecSource(
  source: string,
  caseId: string,
  plan: Plan,
  options: SpecCheckOptions = {},
): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const sf = ts.createSourceFile(`${caseId}.spec.ts`, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const planCase = plan.cases.find((c) => c.id === caseId);
  if (!planCase) return [{ check: "coverage", message: `${caseId} is not in the approved plan` }];
  const native = planCase.type === "mobile";

  let exportsCaseId = false;
  let exportsRun = false;
  const stepCalls = new Map<string, number>();
  const verifiedSteps = new Set<string>();
  const verifiedFields = new Set<string>();
  const downloadSteps = new Set<string>();
  const add = (check: SpecProblem["check"], message: string, node?: ts.Node): void => {
    problems.push({ check, message, ...(node ? { line: lineOf(sf, node) } : {}) });
  };

  for (const statement of sf.statements) {
    if (ts.isImportDeclaration(statement)) {
      const from = (statement.moduleSpecifier as ts.StringLiteral).text;
      const typeOnly = statement.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword;
      if (from !== "@qajitsu/steps" || !typeOnly)
        add(
          "lint",
          `only 'import type ... from "@qajitsu/steps"' is allowed, found import from '${from}'`,
          statement,
        );
    } else if (ts.isExportDeclaration(statement) || ts.isExportAssignment(statement)) {
      add("lint", "re-exports and default exports are not allowed", statement);
    } else if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === "caseId") {
          if (d.initializer && ts.isStringLiteral(d.initializer) && d.initializer.text === caseId)
            exportsCaseId = true;
          else add("lint", `export const caseId must be "${caseId}"`, d);
        }
      }
    } else if (
      ts.isFunctionDeclaration(statement) &&
      statement.name?.text === "run" &&
      statement.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      exportsRun = true;
    }
  }
  if (!exportsCaseId) add("lint", `missing 'export const caseId = "${caseId}"'`);
  if (!exportsRun) add("lint", "missing 'export async function run(context)'");

  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && FORBIDDEN_GLOBALS.has(node.text)) {
      const parent = node.parent;
      const isPropertyName = ts.isPropertyAccessExpression(parent) && parent.name === node;
      const isKey =
        (ts.isPropertyAssignment(parent) && parent.name === node) ||
        (ts.isBindingElement(parent) && parent.propertyName === node);
      if (!isPropertyName && !isKey)
        add("lint", `'${node.text}' is not allowed in specs; use the provided api client`, node);
    }
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword)
      add("lint", "dynamic import() is not allowed", node);
    // Defence in depth for the sandbox: no reflective access to constructors or prototypes.
    if (ts.isPropertyAccessExpression(node) && FORBIDDEN_MEMBERS.has(node.name.text)) {
      add("lint", `'.${node.name.text}' is not allowed in specs`, node);
    }
    if (ts.isElementAccessExpression(node)) {
      const key = node.argumentExpression;
      if (!ts.isStringLiteral(key) && !ts.isNumericLiteral(key))
        add("lint", "computed member access is not allowed in specs; use literal keys", node);
      else if (ts.isStringLiteral(key) && FORBIDDEN_MEMBERS.has(key.text))
        add("lint", `'["${key.text}"]' is not allowed in specs`, node);
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function")
      add("lint", "new Function is not allowed", node);
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const first = node.arguments[0];
      if (name === "step") {
        if (!first || !ts.isStringLiteral(first)) add("coverage", "step() needs a literal step id", node);
        else stepCalls.set(first.text, (stepCalls.get(first.text) ?? 0) + 1);
      }
      const onUi =
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "ui";
      if (native && onUi && name !== undefined) {
        const unavailable = NATIVE_UNAVAILABLE[name];
        if (unavailable !== undefined) add("lint", unavailable, node);
        if (name === "goto" && options.deepLinks !== true)
          add(
            "lint",
            "ui.goto() in a native app needs mobile.deep_link_scheme; the app is already open: tap its elements instead",
            node,
          );
        if (
          UI_ACTIONS.has(name) &&
          first &&
          ts.isStringLiteral(first) &&
          !NATIVE_SELECTORS.some((k) => first.text.startsWith(k))
        )
          add(
            "lint",
            `'${first.text}' cannot be found in a native app: use testid:, label:, text:, id: or xpath:`,
            node,
          );
        // REQ-EXEC-21/AC6: XPath follows the screen's structure and breaks with it.
        if (UI_ACTIONS.has(name) && first && ts.isStringLiteral(first) && first.text.startsWith("xpath:"))
          add("review", `XPath selector '${first.text}' is brittle; prefer testid:, label: or text:`, node);
      }
      const selectorArgs =
        onUi && name !== undefined && UI_ACTIONS.has(name)
          ? [first, ...(name === "dragTo" ? [node.arguments[1]] : [])]
          : [];
      for (const arg of selectorArgs)
        if (!native && arg && ts.isStringLiteral(arg) && !WEB_SELECTORS.some((k) => arg.text.startsWith(k)))
          add(
            "lint",
            `'${arg.text}' cannot be found in a browser: use testid:, role:, label:, placeholder:, alt:, title:, text:, id:, css: or frame:<selector> >> <selector>`,
            node,
          );
      // REQ-EXEC-38/AC1: uploads name files of the case's plan, never paths or bytes.
      if (onUi && name === "upload") {
        const keys = node.arguments.slice(1);
        if (keys.length === 0) add("lint", "ui.upload() needs the plan keys of the files to upload", node);
        for (const k of keys) {
          if (!ts.isStringLiteral(k)) add("lint", "ui.upload() takes literal file keys of the plan", k);
          else if (!(k.text in (planCase.files ?? {})))
            add("coverage", `ui.upload(): '${k.text}' is not a file of ${caseId} in the plan (files)`, k);
        }
      }
      if (onUi && name === "download") {
        const owner = enclosingStep(node);
        if (owner !== undefined) downloadSteps.add(owner);
      }
      if (
        !native &&
        name !== undefined &&
        UI_ACTIONS.has(name) &&
        first &&
        ts.isStringLiteral(first) &&
        first.text.startsWith("css:")
      ) {
        add(
          "review",
          `CSS selector '${first.text}' is brittle; prefer testid:, role: or label: (REQ-EXEC-05/AC2)`,
          node,
        );
      }
      if (name === "verify") {
        if (
          node.arguments.length !== 4 ||
          !first ||
          !ts.isStringLiteral(first) ||
          !node.arguments[1] ||
          !ts.isStringLiteral(node.arguments[1])
        ) {
          add(
            "assertion-lock",
            "verify(stepId, field, actual, expected) needs literal step id and field and exactly 4 arguments",
            node,
          );
        } else {
          const stepId = first.text;
          const field = node.arguments[1].text;
          // REQ-EXEC-03/AC2: a verify() belongs to the step whose function contains it; the runtime refuses others.
          const owner = enclosingStep(node);
          if (owner !== stepId)
            add(
              "coverage",
              `verify("${stepId}", ...) must be inside step("${stepId}", ...); ${owner === undefined ? "it is outside every step" : `it is inside step("${owner}", ...)`}`,
              node,
            );
          verifiedSteps.add(stepId);
          verifiedFields.add(`${stepId}.${field}`);
          const expected = node.arguments[3];
          const ok =
            expected !== undefined &&
            ts.isCallExpression(expected) &&
            ts.isPropertyAccessExpression(expected.expression) &&
            expected.expression.name.text === "expect" &&
            ts.isIdentifier(expected.expression.expression) &&
            expected.expression.expression.text === "plan" &&
            expected.arguments.length === 1 &&
            expected.arguments[0] !== undefined &&
            ts.isStringLiteral(expected.arguments[0]) &&
            expected.arguments[0].text === `${caseId}.${stepId}.${field}`;
          if (!ok)
            add(
              "assertion-lock",
              `verify("${stepId}", "${field}", ...) must use plan.expect("${caseId}.${stepId}.${field}") as the expected value`,
              node,
            );
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const step of planCase.steps) {
    const count = stepCalls.get(step.id) ?? 0;
    if (count === 0) add("coverage", `plan step ${step.id} has no step("${step.id}") call`);
    if (count > 1) add("coverage", `step("${step.id}") appears ${String(count)} times`);
    // REQ-EXEC-11: a manual step is checked by a person; the spec only marks where it happens.
    if (step.manual === true) {
      if (verifiedSteps.has(step.id))
        add(
          "coverage",
          `step ${step.id} is manual: a person reports its outcome, the spec must not verify it`,
        );
      continue;
    }
    if (!verifiedSteps.has(step.id))
      add("coverage", `plan step ${step.id} has no verify("${step.id}", ...) call`);
    // A planned download without ui.download() in its step would always fail as "no download".
    if (step.expect.download !== undefined && !downloadSteps.has(step.id))
      add(
        "coverage",
        `step ${step.id} expects a download: call ui.download(<selector>) inside step("${step.id}", ...)`,
      );
    // Every planned expectation is verified; leaving one out would let the spec pass whatever it is.
    for (const field of plannedFields(step.expect))
      if (verifiedSteps.has(step.id) && !verifiedFields.has(`${step.id}.${field}`))
        add("coverage", `expectation ${step.id} ${field} has no verify("${step.id}", "${field}", ...) call`);
  }
  for (const id of stepCalls.keys()) {
    if (!planCase.steps.some((s) => s.id === id)) add("coverage", `step("${id}") is not a step of ${caseId}`);
  }
  // A verify() of something the step does not expect has no expected value: plan.expect() would stop the attempt.
  for (const key of verifiedFields) {
    const dot = key.indexOf(".");
    const step = planCase.steps.find((s) => s.id === key.slice(0, dot));
    const field = key.slice(dot + 1);
    if (!step || step.manual === true) continue;
    const planned = plannedFields(step.expect);
    if (!planned.includes(field))
      add(
        "coverage",
        `verify("${step.id}", "${field}", ...) checks something step ${step.id} of the plan does not expect; it expects: ${planned.join(", ") || "a description only, nothing a test can compare"}`,
      );
  }
  // A case that runs as a test account logs in as it: without it every call answers 401 and the case would end
  // FAILED as if the product were broken (exploratory testing F21).
  const account = Object.values(planCase.data).find(
    (v): v is string => typeof v === "string" && /^user:[\w.-]+$/.test(v),
  );
  if (account !== undefined && (planCase.type === "api" || planCase.type === "web")) {
    const client = planCase.type === "api" ? "api" : "ui";
    const runsAs = `${caseId} runs as ${account} (data.user in the plan)`;
    const loggedIn = new Set<string>();
    // Set while walking the tree; an object, so the check after the walk is not narrowed away.
    const login = { thrownAway: false };
    const anonymous: { step: string; verb: string }[] = [];
    /** The plan step a node belongs to: the id of its enclosing `step("Sx", ...)`. */
    const stepOf = (node: ts.Node): string | undefined => {
      for (let n = node.parent; !ts.isSourceFile(n); n = n.parent)
        if (
          ts.isCallExpression(n) &&
          calleeName(n) === "step" &&
          n.arguments[0] &&
          ts.isStringLiteral(n.arguments[0])
        )
          return n.arguments[0].text;
      return undefined;
    };
    const findLogins = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
        const member = node.expression.name.text;
        const [first] = node.arguments;
        if (member === "as" && first !== undefined && ts.isStringLiteral(first) && first.text === account) {
          loggedIn.add(first.text);
          // api.as() returns the logged-in client; a call whose result is dropped logs nobody in.
          const parent = ts.isAwaitExpression(node.parent) ? node.parent.parent : node.parent;
          if (client === "api" && ts.isExpressionStatement(parent)) login.thrownAway = true;
        }
        if (
          client === "api" &&
          ts.isIdentifier(node.expression.expression) &&
          node.expression.expression.text === "api" &&
          HTTP_VERBS.has(member)
        ) {
          const step = stepOf(node) ?? "?";
          // A step about the 401 itself calls without logging in on purpose.
          const expects401 = planCase.steps.find((x) => x.id === step)?.expect.status === 401;
          if (!expects401 && !anonymous.some((a) => a.step === step && a.verb === member))
            anonymous.push({ step, verb: member });
        }
      }
      ts.forEachChild(node, findLogins);
    };
    findLogins(sf);
    if (!loggedIn.has(account))
      add(
        "coverage",
        `${runsAs} but the spec never logs in as it: use ${client}.as("${account}") for its calls`,
      );
    else if (login.thrownAway)
      add(
        "coverage",
        `${runsAs} but api.as("${account}") is called and its client thrown away: keep it, e.g. const user = api.as("${account}"), and make the calls with it`,
      );
    if (loggedIn.has(account))
      for (const a of anonymous)
        add(
          "coverage",
          `${runsAs} but step ${a.step} calls api.${a.verb} without logging in: use the client api.as("${account}") returns`,
        );
  }
  // REQ-VER-23: the test code quality gate; its findings stop the spec like any other check.
  for (const f of checkSpecQuality(source, caseId, plan))
    problems.push({ check: "quality", message: `${f.rule}: ${f.message}`, line: f.line });
  return problems;
}

/**
 * Path of the `@qajitsu/steps` type declarations used to type-check specs: the sources when present (monorepo
 * development, always current), otherwise the built declarations (installed package).
 *
 * @param exists - File check, injectable for tests.
 */
export function stepsTypesEntry(exists: (path: string) => boolean = existsSync): string {
  const here = dirname(new URL(import.meta.url).pathname);
  // Sources first: in the monorepo they are always current, while dist/ may lag behind the last change.
  const src = join(here, "../../steps/src/index.ts");
  return exists(src) ? src : join(here, "../../steps/dist/index.d.ts");
}

/**
 * Type-checks specs against the `@qajitsu/steps` API (`tsc --noEmit` equivalent; REQ-EXEC-03/AC1).
 *
 * @param files - Absolute spec paths.
 * @returns Problems per file.
 */
/** Parsed library and steps files shared between checks, by path and modification time (specs are never cached). */
const sourceCache = new Map<string, { readonly mtimeMs: number; readonly source: ts.SourceFile }>();

/** A compiler host that reuses parsed files that are not the specs under check, like the TypeScript language service. */
function cachingHost(options: ts.CompilerOptions, specs: ReadonlySet<string>): ts.CompilerHost {
  const host = ts.createCompilerHost(options, true);
  const parse = host.getSourceFile.bind(host);
  host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
    if (specs.has(fileName)) return parse(fileName, languageVersion, onError, shouldCreate);
    const mtimeMs = statSync(fileName, { throwIfNoEntry: false })?.mtimeMs ?? -1;
    const cached = sourceCache.get(fileName);
    if (cached?.mtimeMs === mtimeMs) return cached.source;
    const source = parse(fileName, languageVersion, onError, shouldCreate);
    if (source) sourceCache.set(fileName, { mtimeMs, source });
    return source;
  };
  return host;
}

export function typecheckSpecs(files: readonly string[]): Map<string, SpecProblem[]> {
  const options: ts.CompilerOptions = {
    strict: true,
    noEmit: true,
    target: ts.ScriptTarget.ES2023,
    module: ts.ModuleKind.NodeNext,
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    skipLibCheck: true,
    types: [],
    lib: ["lib.es2023.d.ts"],
    paths: { "@qajitsu/steps": [stepsTypesEntry()] },
    allowImportingTsExtensions: true,
  };
  const program = ts.createProgram([...files], options, cachingHost(options, new Set(files)));
  const out = new Map<string, SpecProblem[]>(files.map((f) => [f, []]));
  // Only the specs' own diagnostics count: checking every file of the program (the steps and core sources the spec
  // imports) did the same work again for each spec and was thrown away.
  const diagnostics = files.flatMap((f) => {
    const source = program.getSourceFile(f);
    return source
      ? [...program.getSyntacticDiagnostics(source), ...program.getSemanticDiagnostics(source)]
      : [];
  });
  for (const d of [...program.getOptionsDiagnostics(), ...program.getGlobalDiagnostics(), ...diagnostics]) {
    const file = d.file?.fileName;
    if (file === undefined || !out.has(file)) continue;
    const line =
      d.start === undefined ? undefined : (d.file?.getLineAndCharacterOfPosition(d.start).line ?? 0) + 1;
    out.get(file)?.push({
      check: "typecheck",
      message: ts.flattenDiagnosticMessageText(d.messageText, "\n"),
      ...(line === undefined ? {} : { line }),
    });
  }
  return out;
}

/** Problems that stop a spec from running; `review` findings are only reported. */
export function blockingProblems(problems: readonly SpecProblem[]): SpecProblem[] {
  return problems.filter((p) => p.check !== "review");
}

/** Formats problems for the author's repair prompt or the terminal. */
export function formatSpecProblems(problems: readonly SpecProblem[]): string {
  return problems
    .map((p) => `${p.check}${p.line === undefined ? "" : ` (line ${String(p.line)})`}: ${p.message}`)
    .join("\n");
}

interface LockedShape {
  steps: string[];
  verifies: string[];
  expects: string[];
  tries: number;
  /** UI and API actions in order, without their selectors (which the healer may change). */
  actions: string[];
  /** Control flow that could skip or redirect checks. */
  flow: string[];
}

const SELECTOR_ACTIONS = new Set([
  "click",
  "check",
  "uncheck",
  "waitFor",
  "fill",
  "select",
  "press",
  "hover",
  "dblclick",
  "rightClick",
  "dragTo",
  "dragBy",
  "scrollTo",
  "scrollUntil",
  "upload",
  "download",
]);
/** Actions the healer may add or remove like waits: they only bring an element into reach (REQ-EXEC-09). */
const WAIT_LIKE = new Set(["waitFor", "scrollTo"]);

const lockedShape = (source: string): LockedShape => {
  const sf = ts.createSourceFile("spec.ts", source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const shape: LockedShape = { steps: [], verifies: [], expects: [], tries: 0, actions: [], flow: [] };
  const visit = (node: ts.Node): void => {
    if (ts.isTryStatement(node)) shape.tries += 1;
    if (
      ts.isIfStatement(node) ||
      ts.isConditionalExpression(node) ||
      ts.isReturnStatement(node) ||
      ts.isThrowStatement(node) ||
      ts.isIterationStatement(node, false) ||
      ts.isSwitchStatement(node) ||
      ts.isBreakOrContinueStatement(node)
    ) {
      shape.flow.push(ts.SyntaxKind[node.kind]);
    }
    if (
      ts.isBinaryExpression(node) &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(node.operatorToken.kind)
    ) {
      shape.flow.push(ts.SyntaxKind[node.operatorToken.kind]);
    }
    if (ts.isCallExpression(node)) {
      const name = calleeName(node);
      const literal = (i: number): string => {
        const a = node.arguments[i];
        return a && ts.isStringLiteral(a) ? a.text : `<${a ? a.getText(sf) : "missing"}>`;
      };
      if (name === "step") shape.steps.push(literal(0));
      if (
        name !== undefined &&
        ts.isPropertyAccessExpression(node.expression) &&
        !["step", "verify", "expect"].includes(name)
      ) {
        // The receiver chain (ui, api.as("user:x")) and every non-selector argument are locked.
        const receiver = node.expression.expression.getText(sf);
        const args = node.arguments.map((a, i) =>
          SELECTOR_ACTIONS.has(name) && (i === 0 || (name === "dragTo" && i === 1))
            ? "<selector>"
            : a.getText(sf),
        );
        if (!WAIT_LIKE.has(name)) shape.actions.push(`${receiver}.${name}(${args.join(",")})`);
      }
      if (name === "verify")
        shape.verifies.push(`${literal(0)}|${literal(1)}|${node.arguments[3]?.getText(sf) ?? ""}`);
      if (
        name === "expect" &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === "plan"
      ) {
        shape.expects.push(literal(0));
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return shape;
};

/**
 * Assertion lock for the healer (REQ-EXEC-09/AC2): a healed spec may change selectors and waits, but
 * its `step()` ids, `verify()` calls (step, field and expected value) and `plan.expect(...)` keys must be
 * identical, and it may not add `try` blocks that could swallow failures.
 *
 * @param before - Original spec source.
 * @param after - Healed spec source.
 * @returns Problems; empty when the change only touches selectors and waits.
 */
export function assertionLockDiff(before: string, after: string): SpecProblem[] {
  const a = lockedShape(before);
  const b = lockedShape(after);
  const problems: SpecProblem[] = [];
  const same = (x: string[], y: string[]): boolean => x.length === y.length && x.every((v, i) => v === y[i]);
  if (!same(a.steps, b.steps))
    problems.push({
      check: "assertion-lock",
      message: `step() calls changed: ${a.steps.join(", ")} → ${b.steps.join(", ")}`,
    });
  if (!same(a.verifies, b.verifies))
    problems.push({
      check: "assertion-lock",
      message: "verify() calls changed; the healer may change selectors and waits only",
    });
  if (!same(a.expects, b.expects))
    problems.push({ check: "assertion-lock", message: "plan.expect(...) keys changed" });
  if (b.tries > a.tries)
    problems.push({
      check: "assertion-lock",
      message: "try/catch was added; failures must not be swallowed",
    });
  return problems;
}
