import { existsSync } from "node:fs";
import { plannedFields } from "./expectations.js";
import { dirname, join } from "node:path";
import type { Plan } from "@qajitsu/core";
import ts from "typescript";

/** One problem found in a generated spec. */
export interface SpecProblem {
  /** `review` findings are reported but do not block execution (e.g. CSS selectors, REQ-EXEC-05/AC2). */
  readonly check: "typecheck" | "lint" | "coverage" | "assertion-lock" | "review";
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

const UI_ACTIONS = new Set(["click", "fill", "check", "uncheck", "select", "press", "waitFor"]);

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

/**
 * Lint, plan coverage and assertion lock of one spec (REQ-EXEC-03/AC1..AC3, invariant 4). Pure AST
 * checks, no execution:
 * - only `import type` from `@qajitsu/steps`; no dynamic import, no `process`, `require`, `fetch`,
 *   `eval`, `globalThis` (the spec cannot reach files, secrets or the network except through `api`);
 * - exports `caseId` equal to the case and `run`;
 * - every plan step has exactly one `step("Sx")` and at least one `verify("Sx", ...)`; a manual step
 *   (REQ-EXEC-11) has its `step("Sx", () => {})` and no `verify()`;
 * - every `verify()` has 4 arguments and the 4th is `plan.expect("<case>.<step>.<field>")` with the
 *   same step and field as the call, so expected values always come from the approved plan.
 *
 * @param source - Spec source.
 * @param caseId - Case the spec must implement.
 * @param plan - Approved plan.
 */
export function checkSpecSource(source: string, caseId: string, plan: Plan): SpecProblem[] {
  const problems: SpecProblem[] = [];
  const sf = ts.createSourceFile(`${caseId}.spec.ts`, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const planCase = plan.cases.find((c) => c.id === caseId);
  if (!planCase) return [{ check: "coverage", message: `${caseId} is not in the approved plan` }];

  let exportsCaseId = false;
  let exportsRun = false;
  const stepCalls = new Map<string, number>();
  const verifiedSteps = new Set<string>();
  const verifiedFields = new Set<string>();
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
      if (
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
    // Every planned expectation is verified; leaving one out would let the spec pass whatever it is.
    for (const field of plannedFields(step.expect))
      if (verifiedSteps.has(step.id) && !verifiedFields.has(`${step.id}.${field}`))
        add("coverage", `expectation ${step.id} ${field} has no verify("${step.id}", "${field}", ...) call`);
  }
  for (const id of stepCalls.keys()) {
    if (!planCase.steps.some((s) => s.id === id)) add("coverage", `step("${id}") is not a step of ${caseId}`);
  }
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
  const program = ts.createProgram([...files], options);
  const out = new Map<string, SpecProblem[]>(files.map((f) => [f, []]));
  for (const d of ts.getPreEmitDiagnostics(program)) {
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

const SELECTOR_ACTIONS = new Set(["click", "check", "uncheck", "waitFor", "fill", "select", "press"]);

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
          SELECTOR_ACTIONS.has(name) && i === 0 ? "<selector>" : a.getText(sf),
        );
        if (name !== "waitFor") shape.actions.push(`${receiver}.${name}(${args.join(",")})`);
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
