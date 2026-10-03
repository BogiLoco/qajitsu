// Pure policy functions used by the hook scripts. Kept pure so they are easy to unit test.

import { findSecrets } from "./secret-patterns.mjs";
import { normalizePath } from "./hook-io.mjs";

const ALLOW = Object.freeze({ decision: "allow" });
const deny = (reason) => ({ decision: "deny", reason });
const ask = (reason) => ({ decision: "ask", reason });

const SEP = String.raw`(?:^|[;&|]\s*|\(\s*|\s)`;

const BASH_DENY = [
  {
    re: /\brm\s+-[a-zA-Z]*(?:r[a-zA-Z]*f|f[a-zA-Z]*r)[a-zA-Z]*\s+(?:--\s+)?(?:\/|\/\*|~|~\/|\$HOME|\.|\.\/|\.\.|\*)(?=\s|$|;|&|\|)/,
    reason: "Recursive delete of /, ~, ., .. or * is blocked. Delete specific paths instead.",
  },
  {
    re: /\bgit\s+push\b[^;&|]*\s(?:--force(?!-with-lease)\b|-f\b)/,
    reason: "Force push is blocked. Use --force-with-lease on your own branch, and only when the user asked.",
  },
  {
    re: /\bgit\s+push\b[^;&|]*\s(?:origin\s+|upstream\s+)?(?:HEAD:)?(?:main|master)\b/,
    reason: "Pushing to main/master is blocked. Push a feature branch and open a PR.",
  },
  {
    re: /\bgit\s+(?:commit|push|merge|rebase)\b[^;&|]*--no-verify\b/,
    reason: "--no-verify is not allowed. Fix the failing check instead (see /verify).",
  },
  {
    re: new RegExp(`${SEP}(?:npm|pnpm|yarn)\\s+publish\\b|\\bchangeset\\s+publish\\b`),
    reason: "Publishing is done by CI only (see /release).",
  },
  {
    re: new RegExp(`${SEP}(?:npm|yarn)\\s+(?:install|i|add|ci|remove|uninstall|update|run|test|exec)\\b`),
    reason: "This repo uses pnpm. Use the equivalent pnpm command.",
  },
  {
    re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/,
    reason: "Piping downloaded scripts into a shell is blocked.",
  },
  {
    re: new RegExp(
      `${SEP}(?:cat|less|more|head|tail|bat|source|\\.|cp|base64|xxd)\\s+[^;&|]*\\.env(?:\\.local)?(?=\\s|$|;|&|\\|)`,
    ),
    reason:
      "Reading .env files is blocked; secrets must not enter the conversation. Use .env.example to see variable names.",
  },
  {
    re: /\.qa-runs\/[^\s]*\/env\//,
    reason: "Generated run .env files contain secrets and are off limits.",
  },
];

const BASH_ASK = [
  { re: /\bgit\s+reset\s+--hard\b/, reason: "git reset --hard discards work." },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: "git clean deletes untracked files." },
  { re: /\bgit\s+(?:checkout|restore)\s+(?:--\s+)?\.(?=\s|$)/, reason: "This discards all local changes." },
  {
    re: /\bdocker\s+(?:system|volume|network|image)\s+prune\b/,
    reason: "Docker prune affects resources outside QAJitsu.",
  },
  { re: new RegExp(`${SEP}sudo\\s`), reason: "sudo requested." },
];

/**
 * Decides whether a Bash command may run.
 * @param {string} command
 * @returns {{decision: "allow"|"deny"|"ask", reason?: string}}
 */
export function evaluateBash(command = "") {
  const cmd = String(command);
  for (const rule of BASH_DENY) if (rule.re.test(cmd)) return deny(rule.reason);
  for (const rule of BASH_ASK) if (rule.re.test(cmd)) return ask(rule.reason);
  return ALLOW;
}

/** Collects the text a file-editing tool is about to write. */
export function contentOf(toolName, toolInput = {}) {
  switch (toolName) {
    case "Write":
      return toolInput.content ?? "";
    case "Edit":
      return toolInput.new_string ?? "";
    case "MultiEdit":
      return (toolInput.edits ?? []).map((e) => e?.new_string ?? "").join("\n");
    case "NotebookEdit":
      return toolInput.new_source ?? "";
    default:
      return "";
  }
}

/**
 * Decides whether a file edit may happen.
 * @param {string} toolName Write | Edit | MultiEdit | NotebookEdit
 * @param {Record<string, any>} toolInput
 */
export function evaluateFileEdit(toolName, toolInput = {}) {
  const path = normalizePath(toolInput.file_path ?? toolInput.notebook_path ?? "");
  const base = path.split("/").pop() ?? "";

  if (/^\.env(?:\..+)?$/.test(base) && base !== ".env.example") {
    return deny(
      `Writing ${base} is blocked. Document variables in .env.example; real values come from the SecretProvider.`,
    );
  }
  if (base === "pnpm-lock.yaml") {
    return deny("Do not edit pnpm-lock.yaml by hand. Change package.json and run pnpm install.");
  }
  if (/(?:^|\/)\.qa-runs\//.test(path)) {
    return deny("Run workspaces under .qa-runs/ are produced by QAJitsu itself. Do not edit them.");
  }

  const secrets = findSecrets(contentOf(toolName, toolInput));
  if (secrets.length > 0) {
    return deny(
      `The content looks like it contains credentials (${secrets.join(", ")}). Replace them with placeholders such as <TOKEN> or secret:// references. If this is a scrubbing test, build the fake value at runtime.`,
    );
  }
  return ALLOW;
}

/**
 * Finds convention violations in a file that was just edited.
 * @param {string} relPath path relative to the project root, forward slashes
 * @param {string} text file content
 * @returns {string[]} human-readable problems (empty when fine)
 */
export function findEditViolations(relPath, text) {
  const problems = [];
  const lines = String(text).split("\n");
  const isTs = /\.(?:ts|mts|tsx)$/.test(relPath) && !relPath.endsWith(".d.ts");
  const isTest = /\.test\.(?:ts|mts|tsx)$/.test(relPath) || relPath.startsWith("tests/");
  const isSrc = /^packages\/.+\/src\//.test(relPath) && !isTest;

  lines.forEach((line, i) => {
    const n = i + 1;
    if (isTs && isSrc && /\bconsole\.(?:log|debug|info|warn|error|trace)\s*\(/.test(line)) {
      problems.push(`${relPath}:${n} console.* in library code; use the injected pino logger.`);
    }
    if (isTs && isSrc && /@ts-ignore\b/.test(line)) {
      problems.push(`${relPath}:${n} @ts-ignore is not allowed; fix the type or use a typed guard.`);
    }
    if (isTs && isSrc && /(?::\s*any\b|\bas\s+any\b|<any>)/.test(line)) {
      problems.push(`${relPath}:${n} 'any' in library code; use unknown + Zod or a precise type.`);
    }
    if (isTs && isTest && /\b(?:it|test|describe)\.only\s*\(/.test(line)) {
      problems.push(`${relPath}:${n} .only left in a test; remove it before finishing.`);
    }
  });
  return problems;
}

/**
 * Parses `git status --porcelain` output into paths (renames resolve to the new path).
 * @param {string} porcelain
 * @returns {string[]}
 */
export function parsePorcelain(porcelain) {
  return String(porcelain)
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => l.slice(3))
    .map((p) => (p.includes(" -> ") ? p.split(" -> ").pop() : p))
    .map((p) => p.replace(/^"|"$/g, ""));
}

/**
 * Decides whether Claude may stop: library source changed without any test change.
 * @param {string[]} changedPaths
 * @returns {{block: boolean, reason?: string}}
 */
export function evaluateStop(changedPaths) {
  const src = changedPaths.filter(
    (p) =>
      /^packages\/.+\/src\/.+\.(?:ts|mts)$/.test(p) && !/\.test\.(?:ts|mts)$/.test(p) && !p.endsWith(".d.ts"),
  );
  const tests = changedPaths.filter((p) => /\.test\.(?:ts|mts)$/.test(p) || p.startsWith("tests/"));
  if (src.length > 0 && tests.length === 0) {
    const list = src.slice(0, 5).join(", ") + (src.length > 5 ? `, +${src.length - 5} more` : "");
    return {
      block: true,
      reason: `Library code changed without any test change (${list}). Add or update tests (see /tdd), or explain why no test is needed, then run /verify.`,
    };
  }
  return { block: false };
}

/**
 * True when the change touches the requirements catalogue, so the Stop hook should run `req:check`.
 * @param {string[]} changedPaths
 */
export function touchesRequirements(changedPaths) {
  return changedPaths.some((p) => /^docs\/(?:requirements\/.+|roadmap)\.md$/.test(p));
}

/**
 * Turns a failed requirements check into a Stop-hook block reason.
 * @param {number | null} exitCode
 * @param {string} output stderr/stdout of `node scripts/requirements.mjs check`
 */
export function evaluateRequirementsCheck(exitCode, output = "") {
  if (exitCode === 0) return { block: false };
  const problems = String(output)
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("- "))
    .slice(0, 8);
  return {
    block: true,
    reason:
      "The requirements catalogue is invalid after your edits (pnpm req:check). " +
      (problems.length ? `Problems: ${problems.join(" ")} ` : "") +
      "Fix them; if only the index is stale, run pnpm req:index.",
  };
}

const READONLY_PREFIXES = [
  /^git\s+(?:diff|log|show|status|blame|rev-parse|ls-files|merge-base|branch|shortlog|grep)\b/,
  /^(?:ls|cat|head|tail|wc|grep|rg|sort|uniq|cut|jq|echo|pwd|tree|file|stat|realpath|dirname|basename)\b/,
  /^find\b(?!.*\s-(?:delete|exec|execdir|ok|fprint)\b)/,
  /^pnpm\s+(?:test|vitest|verify|lint|typecheck|test:adversarial|req:check|req:list|exec\s+tsc|ls|why)\b/,
  /^node\s+scripts\/requirements\.mjs\s+(?:check|list)\b/,
  /^node\s+--test\b/,
];

/**
 * Decides whether a Bash command is read-only enough for reviewer subagents.
 * @param {string} command
 */
export function evaluateReadonlyBash(command = "") {
  const cmd = String(command)
    .replace(/\b[12]?>&[12]\b/g, "")
    .replace(/\b2>\s*\/dev\/null\b/g, "");
  if (/>{1,2}/.test(cmd) || /\btee\b/.test(cmd)) {
    return deny("Reviewer agents are read-only: output redirection is not allowed.");
  }
  if (/[`]|\$\(/.test(cmd)) {
    return deny("Reviewer agents are read-only: command substitution is not allowed.");
  }
  const segments = cmd
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  const bad = segments.find((s) => !READONLY_PREFIXES.some((re) => re.test(s)));
  if (bad) {
    return deny(
      `Reviewer agents are read-only; '${bad.split(/\s+/).slice(0, 3).join(" ")}' is not on the read-only list.`,
    );
  }
  return ALLOW;
}
