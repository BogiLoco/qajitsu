import type { Plan } from "@qajitsu/core";
import ts from "typescript";

/** One finding of the test code quality gate (REQ-VER-23); every finding stops the spec from running. */
export interface QualityFinding {
  readonly rule:
    | "constant-actual"
    | "swallowed-error"
    | "skippable-verify"
    | "early-return"
    | "disabled-case"
    | "general-target";
  readonly message: string;
  readonly line: number;
}

/** Selectors that stand for the whole page or screen, not one element (REQ-VER-23/AC3). */
const PAGE_SELECTORS =
  /^(css:\s*(body|html|\*|:root|main)\s*$|xpath:\s*\/?\/?(html|body)\s*$|role:\s*(main|document|application)\s*$)/i;

/** A planned text shorter than this is found on almost any page or response. */
const MIN_TEXT_LENGTH = 3;

const lineOf = (sf: ts.SourceFile, node: ts.Node): number =>
  sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1;

const isVerify = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "verify";

const isStepCall = (node: ts.Node): node is ts.CallExpression =>
  ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "step";

const isPlanExpect = (node: ts.Node): boolean =>
  ts.isCallExpression(node) &&
  ts.isPropertyAccessExpression(node.expression) &&
  node.expression.name.text === "expect" &&
  ts.isIdentifier(node.expression.expression) &&
  node.expression.expression.text === "plan";

/** A value the application cannot influence: a literal, a literal structure, or a planned expectation. */
const isConstant = (node: ts.Expression): boolean => {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return isConstant(node.expression);
  if (ts.isIdentifier(node)) return node.text === "NaN" || node.text === "Infinity";
  if (
    ts.isStringLiteral(node) ||
    ts.isNumericLiteral(node) ||
    ts.isNoSubstitutionTemplateLiteral(node) ||
    node.kind === ts.SyntaxKind.TrueKeyword ||
    node.kind === ts.SyntaxKind.FalseKeyword ||
    node.kind === ts.SyntaxKind.NullKeyword
  )
    return true;
  if (ts.isPrefixUnaryExpression(node)) return isConstant(node.operand);
  if (ts.isArrayLiteralExpression(node)) return node.elements.every((e) => isConstant(e));
  if (ts.isObjectLiteralExpression(node))
    return node.properties.every((p) => ts.isPropertyAssignment(p) && isConstant(p.initializer));
  if (isPlanExpect(node)) return true;
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    const comparison = [
      ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.EqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsToken,
    ].includes(op);
    // `x === x` is always the same, whatever x is.
    if (comparison && node.left.getText() === node.right.getText()) return true;
    return isConstant(node.left) && isConstant(node.right);
  }
  return false;
};

/** Constant declarations of the spec, so `const expected = 200; verify(..., expected, ...)` is seen through. */
const constants = (sf: ts.SourceFile): Set<string> => {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined &&
      ts.isVariableDeclarationList(node.parent) &&
      (node.parent.flags & ts.NodeFlags.Const) !== 0 &&
      isConstant(node.initializer)
    )
      names.add(node.name.text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
};

/** Why a `verify()` might not run: the first construct between it and its step that can skip it. */
const skippedBy = (verify: ts.Node): { what: string; node: ts.Node } | undefined => {
  for (let child: ts.Node = verify, n = verify.parent; !ts.isSourceFile(n); child = n, n = n.parent) {
    // The step's own function and the case's run() are where verify() belongs.
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && isStepCall(n.parent)) return undefined;
    if (ts.isFunctionDeclaration(n)) return undefined;
    if (ts.isIfStatement(n) && child !== n.expression) return { what: "an if", node: n };
    if (ts.isConditionalExpression(n) && child !== n.condition) return { what: "a ?: condition", node: n };
    if (
      ts.isBinaryExpression(n) &&
      child === n.right &&
      [
        ts.SyntaxKind.AmpersandAmpersandToken,
        ts.SyntaxKind.BarBarToken,
        ts.SyntaxKind.QuestionQuestionToken,
      ].includes(n.operatorToken.kind)
    )
      return { what: `a short-circuit ${n.operatorToken.getText()}`, node: n };
    if (ts.isSwitchStatement(n) || ts.isCaseClause(n) || ts.isDefaultClause(n))
      return { what: "a switch", node: n };
    if (
      ts.isForStatement(n) ||
      ts.isForOfStatement(n) ||
      ts.isForInStatement(n) ||
      ts.isWhileStatement(n) ||
      ts.isDoStatement(n)
    )
      return { what: "a loop (it runs zero times on an empty list)", node: n };
    if (ts.isTryStatement(n) && child === n.tryBlock)
      return { what: "a try block (an error before it skips it and the catch hides why)", node: n };
    if (ts.isCatchClause(n)) return { what: "a catch block", node: n };
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n))
      return { what: "a callback that may run late or never", node: n };
    if (ts.isCallExpression(n) && n.questionDotToken !== undefined)
      return { what: "an optional call ?.", node: n };
  }
  return undefined;
};

/** The function a node belongs to (a step's callback, run(), or another function). */
const functionOf = (node: ts.Node): ts.Node | undefined => {
  for (let n = node.parent; !ts.isSourceFile(n); n = n.parent)
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return n;
  return undefined;
};

/** An empty handler: `catch {}`, `catch (e) {}`, `.catch(() => {})`, `.catch(() => undefined)`, `.catch(noop)`. */
const isEmptyHandler = (node: ts.Node): boolean => {
  if (ts.isBlock(node)) return node.statements.length === 0;
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const body = node.body;
    if (ts.isBlock(body)) return body.statements.length === 0;
    return (
      (ts.isIdentifier(body) && body.text === "undefined") ||
      body.kind === ts.SyntaxKind.NullKeyword ||
      ts.isLiteralExpression(body) ||
      body.kind === ts.SyntaxKind.TrueKeyword ||
      body.kind === ts.SyntaxKind.FalseKeyword
    );
  }
  return ts.isIdentifier(node);
};

/** The planned expectation of a field, for the general-target rule. */
const plannedValue = (plan: Plan, caseId: string, stepId: string, field: string): unknown => {
  const expect = plan.cases.find((c) => c.id === caseId)?.steps.find((s) => s.id === stepId)?.expect as
    Record<string, unknown> | undefined;
  if (expect === undefined) return undefined;
  const [kind, ...rest] = field.split(".");
  const section = expect[kind ?? ""];
  if (kind === "texts" && Array.isArray(section)) return section[Number(rest[0])];
  return undefined;
};

/**
 * The test code quality gate (REQ-VER-23): finds, before a generated spec runs, the code that makes an assertion not
 * depend on the application or lets it be skipped or swallowed.
 *
 * - AC1 `constant-actual`: the value passed as actual is a constant, a planned expectation, or `x === x`. The runtime
 *   reads the actual value from the response or the page itself, so such a spec still fails on a bug; it is rejected
 *   because it reads as a tautology and teaches the author to write one.
 * - AC2 `swallowed-error`, `skippable-verify`, `early-return`, `disabled-case`: an empty catch anywhere; a `verify()`
 *   inside a condition, short-circuit, switch, loop, try or catch block, or a callback; a `return` before a `verify()`
 *   of the same function; `.skip`, `.fixme`, `.only`, `xit`, `xdescribe`.
 * - AC3 `general-target`: an element check on the whole page (`css:body`, `role:main`, ...) or a planned text so short
 *   it is found almost anywhere.
 *
 * @param source - The spec.
 * @param caseId - Its case.
 * @param plan - The approved plan.
 * @returns Findings; empty when the spec passes the gate.
 */
export function checkSpecQuality(source: string, caseId: string, plan: Plan): QualityFinding[] {
  const sf = ts.createSourceFile(`${caseId}.spec.ts`, source, ts.ScriptTarget.ES2023, true, ts.ScriptKind.TS);
  const findings: QualityFinding[] = [];
  const add = (rule: QualityFinding["rule"], message: string, node: ts.Node): void => {
    findings.push({ rule, message, line: lineOf(sf, node) });
  };
  const consts = constants(sf);
  const verifies: ts.CallExpression[] = [];
  const returns: ts.ReturnStatement[] = [];

  const visit = (node: ts.Node): void => {
    if (isVerify(node)) verifies.push(node);
    if (ts.isReturnStatement(node)) returns.push(node);
    if (ts.isCatchClause(node) && isEmptyHandler(node.block))
      add("swallowed-error", "an empty catch hides the error of the step; let it fail the step", node);
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "catch" &&
      node.arguments[0] !== undefined &&
      isEmptyHandler(node.arguments[0])
    )
      add(
        "swallowed-error",
        ".catch() with an empty handler hides the error of the step; let it fail the step",
        node,
      );
    if (
      ts.isPropertyAccessExpression(node) &&
      ["skip", "fixme", "only", "todo"].includes(node.name.text) &&
      ts.isIdentifier(node.expression) &&
      ["test", "it", "describe", "step"].includes(node.expression.text)
    )
      add("disabled-case", `${node.getText()} disables or narrows what runs; every planned step runs`, node);
    if (
      ts.isIdentifier(node) &&
      ["xit", "xdescribe", "xtest"].includes(node.text) &&
      ts.isCallExpression(node.parent)
    )
      add("disabled-case", `${node.text}() disables a case; every planned step runs`, node);
    ts.forEachChild(node, visit);
  };
  visit(sf);

  for (const v of verifies) {
    const [stepArg, fieldArg, actual] = v.arguments;
    const label =
      stepArg && fieldArg && ts.isStringLiteral(stepArg) && ts.isStringLiteral(fieldArg)
        ? `verify("${stepArg.text}", "${fieldArg.text}")`
        : "verify()";
    if (
      actual !== undefined &&
      !(ts.isIdentifier(actual) && actual.text === "undefined") &&
      (isConstant(actual) || (ts.isIdentifier(actual) && consts.has(actual.text)))
    )
      add(
        "constant-actual",
        `${label} passes ${actual.getText()} as the actual value, which does not come from the application; pass the response value (e.g. res.status, res.json("total")) or undefined for page checks`,
        v,
      );
    const skip = skippedBy(v);
    if (skip)
      add(
        "skippable-verify",
        `${label} is inside ${skip.what}, so it can be skipped; verify unconditionally in the step`,
        v,
      );
    // A return in the verify()'s own function or in one that contains it (run() before a later step).
    const enclosing = new Set<ts.Node>();
    for (let f = functionOf(v); f !== undefined; f = functionOf(f)) enclosing.add(f);
    const before = returns.find((r) => {
      const owner = functionOf(r);
      return owner !== undefined && enclosing.has(owner) && r.getStart(sf) < v.getStart(sf);
    });
    if (before)
      add(
        "early-return",
        `the return on line ${String(lineOf(sf, before))} can end the step before ${label}`,
        before,
      );
    if (stepArg && fieldArg && ts.isStringLiteral(stepArg) && ts.isStringLiteral(fieldArg)) {
      const field = fieldArg.text;
      if (field.startsWith("elements.")) {
        const selector = field.slice("elements.".length, field.lastIndexOf("."));
        if (PAGE_SELECTORS.test(selector))
          add(
            "general-target",
            `${label} checks the whole page (${selector}) instead of the element the plan names`,
            v,
          );
      }
      const text = plannedValue(plan, caseId, stepArg.text, field);
      if (field.startsWith("texts.") && typeof text === "string" && text.trim().length < MIN_TEXT_LENGTH)
        add(
          "general-target",
          `${label} looks for the text "${text}", which is found almost anywhere; the plan needs a more specific text or an element check`,
          v,
        );
    }
  }
  // One early return can precede several verify() calls; report it once.
  return findings.filter(
    (f, i) =>
      findings.findIndex((x) => x.rule === f.rule && x.line === f.line && x.message === f.message) === i,
  );
}
