import type { PluginPermission } from "@qajitsu/core";
import ts from "typescript";

/** One source or build file of a plugin. */
export interface PluginCodeFile {
  readonly path: string;
  readonly text: string;
}

/** A use in a plugin's code that its permissions do not cover; `never` for what no plugin may do. */
export interface PluginCodeViolation {
  readonly file: string;
  readonly line: number;
  readonly use: string;
  readonly needs: PluginPermission | "never";
}

/** Node's modules by the permission that covers them. */
const MODULES: Readonly<Record<string, PluginPermission>> = {
  net: "network",
  http: "network",
  https: "network",
  http2: "network",
  tls: "network",
  dgram: "network",
  dns: "network",
  "dns/promises": "network",
  child_process: "exec",
  worker_threads: "exec",
  cluster: "exec",
  // Each of these loads or runs code past the other checks: `createRequire`, a new context, a debugger, WebAssembly
  // with system calls, a REPL, a heap snapshot.
  module: "exec",
  vm: "exec",
  inspector: "exec",
  "inspector/promises": "exec",
  wasi: "exec",
  repl: "exec",
  v8: "exec",
  fs: "filesystem",
  "fs/promises": "filesystem",
  sqlite: "filesystem",
  // `import { env } from "node:process"` reads the environment like `process.env`.
  process: "environment",
};

/** How a loaded module is named in a refusal: Node's own as `node:<name>`, anything else as written. */
const moduleUse = (specifier: string): string =>
  Object.hasOwn(MODULES, specifier) ? `node:${specifier}` : specifier;

/** A specifier with a URL scheme other than `node:`, or an absolute path (`/x`, `C:\\x`, `\\\\host\\x`). */
function isOutside(specifier: string): boolean {
  return (
    (/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !specifier.startsWith("node:")) ||
    specifier.startsWith("/") ||
    specifier.startsWith("\\")
  );
}

/** The permission a module specifier needs, or undefined when it is not one of Node's guarded modules. */
function moduleNeeds(specifier: string): PluginPermission | undefined {
  // A native addon runs machine code; a URL (`data:`, `file:`, `https:`) or an absolute path loads code from outside
  // the plugin, which nothing has checked.
  if (specifier.endsWith(".node") || isOutside(specifier)) return "exec";
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return Object.hasOwn(MODULES, name) ? MODULES[name] : undefined;
}

/**
 * Properties of `process` a plugin reads without a permission. `env` needs `environment`; anything else, such as
 * `getBuiltinModule`, `binding`, `dlopen` or `mainModule`, loads code and needs `exec`.
 */
const PROCESS_SAFE = new Set([
  "arch",
  "argv",
  "cwd",
  "emitWarning",
  "exitCode",
  "hrtime",
  "nextTick",
  "off",
  "on",
  "once",
  "pid",
  "platform",
  "release",
  "stderr",
  "stdout",
  "uptime",
  "version",
  "versions",
]);

/** Properties of `process` that reach the environment or load code, whatever object they are read from. */
const PROCESS_DANGEROUS = new Set([
  "env",
  "getBuiltinModule",
  "binding",
  "_linkedBinding",
  "dlopen",
  "mainModule",
]);

/** What reading a property of `process` needs: `environment` for `env`, nothing for the harmless, `exec` otherwise. */
function processNeeds(property: string): PluginPermission | undefined {
  if (property === "env") return "environment";
  return PROCESS_SAFE.has(property) ? undefined : "exec";
}

/** A parsed file with the syntax errors TypeScript records on it. */
type Parsed = ts.SourceFile & { readonly parseDiagnostics?: readonly ts.Diagnostic[] };

/** Names under which code reaches the global object. */
const GLOBALS = new Set(["globalThis", "global", "self", "window"]);

/** Globals that turn a string into code. */
const EVALUATORS = new Set(["eval", "Function"]);

/**
 * Node runs `<!--` and a line starting with `-->` as comments in CommonJS (HTML-like comments); TypeScript parses them
 * as code. Code behind them would be seen differently from how it runs, so such a file is refused.
 */
const HTML_LIKE_COMMENT = /<!--|^[ \t]*(?:\/\*.*?\*\/[ \t]*)*-->/m;

/** A member read by name: `object.name` or `object["name"]`. */
interface Member {
  readonly object: ts.Expression;
  readonly name: string;
}

/** The member `node` reads by name, or undefined for anything else (also a computed key). */
function member(node: ts.Node): Member | undefined {
  if (ts.isPropertyAccessExpression(node)) return { object: node.expression, name: node.name.text };
  if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
    return { object: node.expression, name: node.argumentExpression.text };
  return undefined;
}

/** An expression without the parentheses around it. */
function unwrap(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
}

/** Whether an identifier only names something (a property, a key, a member) rather than using a variable. */
function isLabel(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent)) return parent.name === node;
  if (
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isPropertySignature(parent) ||
    ts.isMethodDeclaration(parent) ||
    ts.isMethodSignature(parent) ||
    ts.isEnumMember(parent)
  )
    return parent.name === node;
  if (ts.isBindingElement(parent)) return parent.propertyName === node;
  return ts.isQualifiedName(parent) || ts.isTypeQueryNode(parent);
}

/** Whether an expression is the global object: `globalThis`, `global`, `self`, `window`, or `globalThis.self` etc. */
function isGlobalObject(node: ts.Node): boolean {
  const inner = ts.isParenthesizedExpression(node) ? unwrap(node) : node;
  if (ts.isIdentifier(inner)) return GLOBALS.has(inner.text) && !isLabel(inner);
  const m = member(inner);
  return m !== undefined && GLOBALS.has(m.name) && isGlobalObject(m.object);
}

/** Whether an expression is `process`: the variable, or the global object's `process`. */
function isProcess(node: ts.Node): boolean {
  const inner = ts.isParenthesizedExpression(node) ? unwrap(node) : node;
  if (ts.isIdentifier(inner)) return inner.text === "process" && !isLabel(inner);
  const m = member(inner);
  return m?.name === "process" && isGlobalObject(m.object);
}

/** The outermost expression a use stands in: through parentheses, to the node that reads from it or passes it on. */
function outermost(node: ts.Expression): ts.Expression {
  return ts.isParenthesizedExpression(node.parent) ? outermost(node.parent) : node;
}

/**
 * The properties a use of an object reads by name: one for `x.name`, the keys of `const { a, b } = x`; or undefined
 * when the use can reach anything (passed on, an alias, a computed key, a rest element, a spread).
 */
function readsOf(node: ts.Expression): string[] | undefined {
  const use = outermost(node);
  const parent = use.parent;
  // `typeof process !== "undefined"` reads nothing.
  if (ts.isTypeOfExpression(parent)) return [];
  // A use is never the key of a member read by name (that is a literal), so it is the object read from.
  const m = member(parent);
  if (m !== undefined) return [m.name];
  // A binding pattern is no expression, so a use whose parent declares one is the declaration's initializer.
  if (ts.isVariableDeclaration(parent) && ts.isObjectBindingPattern(parent.name)) {
    const keys: string[] = [];
    for (const element of parent.name.elements) {
      const raw = element.propertyName ?? element.name;
      const key = ts.isComputedPropertyName(raw) ? raw.expression : raw;
      if (element.dotDotDotToken !== undefined || !(ts.isIdentifier(key) || ts.isStringLiteralLike(key)))
        return undefined;
      keys.push(key.text);
    }
    return keys;
  }
  return undefined;
}

/** `require`, `module.require`, `require.main.require` and every other `x.require`. */
function isRequire(callee: ts.Expression): boolean {
  return ts.isIdentifier(callee) ? callee.text === "require" : member(callee)?.name === "require";
}

/**
 * A module loaded at run time: `import ... from`, `export ... from`, `import()`, `require()`, `import x = require()`;
 * for `require.call(...)` and `require.apply(...)` the whole call, whose strings may all name it.
 */
function loadedModule(node: ts.Node): ts.Node | undefined {
  if (ts.isImportDeclaration(node))
    return node.importClause?.phaseModifier === ts.SyntaxKind.TypeKeyword ? undefined : node.moduleSpecifier;
  if (ts.isExportDeclaration(node)) return node.isTypeOnly ? undefined : node.moduleSpecifier;
  if (ts.isImportEqualsDeclaration(node))
    return !node.isTypeOnly && ts.isExternalModuleReference(node.moduleReference)
      ? node.moduleReference.expression
      : undefined;
  if (!ts.isCallExpression(node)) return undefined;
  const callee = unwrap(node.expression);
  if (callee.kind === ts.SyntaxKind.ImportKeyword || isRequire(callee)) return node.arguments[0];
  const m = member(callee);
  return (m?.name === "call" || m?.name === "apply") && isRequire(unwrap(m.object)) ? node : undefined;
}

/**
 * Collects the modules a load could name: every string in its argument, fail closed, so `"fs" + ""`, `"fs" || x` and
 * `c ? "fs" : "os"` all count; only a name put together from pieces at run time is not seen.
 */
function collectSpecifiers(node: ts.Node, into: Set<string>): void {
  const text = pieceText(node);
  if (text !== undefined) into.add(text);
  ts.forEachChild(node, (child) => {
    collectSpecifiers(child, into);
  });
}

/** A use that needs a permission. */
interface Use {
  readonly use: string;
  readonly needs: PluginPermission;
}

/** What reading these properties of `process` needs; passed on (`undefined`), it could reach anything. */
function processReads(reads: readonly string[] | undefined): Use[] {
  if (reads === undefined) return [{ use: "process passed on", needs: "exec" }];
  return reads.flatMap((name) => {
    const needs = processNeeds(name);
    return needs === undefined ? [] : [{ use: `process.${name}`, needs }];
  });
}

/** What reading these properties of the global object needs; passed on (`undefined`), it could reach anything. */
function globalReads(reads: readonly string[] | undefined): Use[] {
  if (reads === undefined) return [{ use: "the global object passed on", needs: "exec" }];
  return reads.flatMap((name): Use[] =>
    name === "fetch"
      ? [{ use: "global fetch", needs: "network" }]
      : EVALUATORS.has(name)
        ? [{ use: name, needs: "exec" }]
        : [],
  );
}

/** Members that turn a string into code or load a module: `x.constructor` (`Function`), `Module._load`. */
const LOADERS = new Set<string | undefined>(["constructor", "_load"]);

/** Reads that call what they are read from. */
const INVOKERS = new Set(["call", "apply", "bind"]);

/**
 * Destructured keys that take something out of sight: `{ constructor: C }` or `{ _load }` from anything, and
 * `{ process: p }` from anything, since the object may be the global one under another name.
 */
function inBindings(node: ts.Node): Use[] {
  if (!ts.isBindingElement(node)) return [];
  const raw = node.propertyName ?? node.name;
  const key = ts.isComputedPropertyName(raw) ? raw.expression : raw;
  // Stryker disable next-line ConditionalExpression: other keys are numbers or patterns, never a loader or process
  const name = ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined;
  if (LOADERS.has(name)) return [{ use: `.${String(name)}`, needs: "exec" }];
  // A shorthand `{ process }` declares a local `process`, which is checked as process itself.
  return name === "process" && node.propertyName !== undefined
    ? [{ use: "process passed on", needs: "exec" }]
    : [];
}

/** A `data:` URL of a module Node would run (JavaScript or WebAssembly). */
const DATA_MODULE = /^\s*data:\s*(?:text|application)\/(?:javascript|ecmascript|x-javascript|wasm)\b/i;

/** What the line-based check found in any text, kept for code written into strings (`Function("...")`, `data:`). */
const TEXT_SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/g;

/** Code written into a string or a template piece: the modules it loads, `process.env`, the global `fetch`. */
function inStrings(node: ts.Node): Use[] {
  const text = pieceText(node);
  if (text === undefined) return [];
  const out: Use[] = [];
  for (const m of text.matchAll(TEXT_SPECIFIER)) {
    // The capture group is not optional: every match has it.
    const spec = String(m[1]);
    const needs = moduleNeeds(spec);
    if (needs !== undefined) out.push({ use: moduleUse(spec), needs });
  }
  if (/\bprocess\s*\.\s*env\b/.test(text)) out.push({ use: "process.env", needs: "environment" });
  if (/\bprocess\s*\.\s*(?:getBuiltinModule|binding|_linkedBinding|dlopen|mainModule)\b/.test(text))
    out.push({ use: "process in a string", needs: "exec" });
  if (/\bglobalThis\s*\.\s*fetch\b/.test(text)) out.push({ use: "global fetch", needs: "network" });
  // Held in a variable and imported later; one written straight into an import is a load already.
  if (DATA_MODULE.test(text) && loadedModule(node.parent) !== node)
    out.push({ use: "a data: module in a string", needs: "exec" });
  return out;
}

/** The uses one node makes: a module it loads, code it evaluates, what it reads of `process` or the global object. */
function usesOf(node: ts.Node): Use[] {
  const out: Use[] = [];
  const loaded = loadedModule(node);
  const specifiers = new Set<string>();
  if (loaded !== undefined) collectSpecifiers(loaded, specifiers);
  for (const specifier of specifiers) {
    const needs = moduleNeeds(specifier);
    if (needs !== undefined)
      out.push({
        use: moduleUse(specifier),
        needs,
      });
  }
  if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
    const callee = unwrap(node.expression);
    if (ts.isIdentifier(callee) && EVALUATORS.has(callee.text)) out.push({ use: callee.text, needs: "exec" });
  }
  // `(() => {}).constructor` is `Function`, `module.constructor._load` Node's own module loader: called, held, or
  // passed on, they run code; only a named read of them (`.constructor.name`) is harmless.
  const loader = member(node)?.name;
  if (LOADERS.has(loader)) {
    const reads = readsOf(node as ts.Expression);
    if (reads === undefined || reads.some((r) => INVOKERS.has(r)))
      out.push({ use: `.${String(loader)}`, needs: "exec" });
  }
  out.push(...inBindings(node));
  // `eval` or `Function` held rather than called (`const F = Function`) can run code anywhere.
  if (ts.isIdentifier(node) && EVALUATORS.has(node.text) && !isLabel(node)) {
    const use = outermost(node);
    if (!(
      (ts.isCallExpression(use.parent) || ts.isNewExpression(use.parent)) &&
      use.parent.expression === use
    ))
      out.push({ use: `${node.text} passed on`, needs: "exec" });
  }
  out.push(...inStrings(node));
  // Parentheses are looked through from inside, so `(process)` is one use, not two.
  if (ts.isExpression(node) && !ts.isParenthesizedExpression(node)) {
    if (isProcess(node)) out.push(...processReads(readsOf(node)));
    // `globalThis.self` is one global object, reported once, at its outermost name.
    else if (isGlobalObject(node) && !isGlobalObject(outermost(node).parent)) {
      const reads = readsOf(node);
      out.push(...globalReads(reads));
    }
    // `const p = job.process`: an object's `process` passed on may be the real one, from an alias of the global object.
    else if (member(node)?.name === "process" && member(outermost(node).parent) === undefined) {
      const reads = readsOf(node);
      if (reads === undefined) out.push({ use: "process passed on", needs: "exec" });
      else
        for (const name of reads)
          if (PROCESS_DANGEROUS.has(name))
            out.push({ use: `process.${name}`, needs: name === "env" ? "environment" : "exec" });
    }
  }
  // `<anything>.process.env`: through an alias of the global object, `this`, or a function that returns it.
  const m = member(node);
  if (
    m !== undefined &&
    PROCESS_DANGEROUS.has(m.name) &&
    member(unwrap(m.object))?.name === "process" &&
    !isProcess(m.object)
  )
    out.push({ use: `process.${m.name}`, needs: m.name === "env" ? "environment" : "exec" });
  return out;
}

/** Text of a string or a template piece. */
function pieceText(node: ts.Node): string | undefined {
  return ts.isStringLiteralLike(node) ||
    ts.isTemplateHead(node) ||
    ts.isTemplateMiddle(node) ||
    ts.isTemplateTail(node)
    ? node.text
    : undefined;
}

/** Text of a string, a template piece or a regular expression, where a path to the frozen plan could be written. */
function literalText(node: ts.Node): string | undefined {
  // A regular expression escapes its dots: /plan\.approved\.yaml/.
  if (ts.isRegularExpressionLiteral(node)) return node.text.replaceAll("\\", "");
  return pieceText(node);
}

/**
 * Checks a plugin's own code against the permissions of its manifest (REQ-GEN-11/AC9, ADR-0015): Node's network,
 * process and file modules, code that loads or runs other code, reads of `process.env` and the global `fetch` must be
 * declared, and no plugin may refer to the frozen plan (invariant 3). Type-only imports and comments are not uses; the
 * plugin's dependencies are not scanned. The code is parsed (TypeScript picks JavaScript or TypeScript by the file's
 * extension), not read line by line, so a comment, a string or a template literal cannot hide code from the check.
 * Fail closed: a file that does not parse, or that has HTML-like comments, is refused, and `process` or the global
 * object passed on rather than read by name counts as all it could reach.
 *
 * @param files - The plugin's own files (its build output, or its sources in this repository).
 * @param permissions - The permissions of its manifest.
 * @returns Every use not covered, in file and line order; empty when the code keeps to its manifest.
 */
export function checkPluginCode(
  files: readonly PluginCodeFile[],
  permissions: readonly PluginPermission[],
): PluginCodeViolation[] {
  const allowed = new Set(permissions);
  const out: PluginCodeViolation[] = [];
  for (const f of files) {
    const source = ts.createSourceFile(f.path, f.text, ts.ScriptTarget.Latest, true);
    const lineAt = (pos: number): number => source.getLineAndCharacterOfPosition(pos).line + 1;
    const refuse = (pos: number, use: string): void => {
      out.push({ file: f.path, line: lineAt(pos), use, needs: "never" });
    };
    const html = HTML_LIKE_COMMENT.exec(f.text);
    if (html !== null) {
      refuse(html.index, "an HTML-like comment");
      continue;
    }
    // TypeScript records syntax errors in an internal field; without it nothing could be told, so nothing passes.
    const diagnostics = (source as Parsed).parseDiagnostics;
    const first = diagnostics?.[0];
    if (diagnostics === undefined || first !== undefined) {
      refuse(first?.start ?? 0, "code that does not parse");
      continue;
    }
    const add = (node: ts.Node, use: string, needs: PluginPermission): void => {
      if (!allowed.has(needs)) out.push({ file: f.path, line: lineAt(node.getStart(source)), use, needs });
    };
    const visit = (node: ts.Node): void => {
      for (const u of usesOf(node)) add(node, u.use, u.needs);
      if (literalText(node)?.includes("plan.approved.yaml") === true)
        refuse(node.getStart(source), "plan.approved.yaml");
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return out;
}

/**
 * The violations as one sentence for a refusal (REQ-GEN-11/AC9), or undefined when there are none.
 *
 * @param violations - From {@link checkPluginCode}.
 */
export function pluginCodeProblems(violations: readonly PluginCodeViolation[]): string | undefined {
  if (violations.length === 0) return undefined;
  return violations
    .map((v) =>
      v.needs === "never"
        ? `${v.file}:${String(v.line)} refers to ${v.use}, which no plugin may`
        : `${v.file}:${String(v.line)} uses ${v.use} without the ${v.needs} permission`,
    )
    .join("; ");
}
