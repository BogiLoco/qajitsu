// Shared I/O helpers for Claude Code command hooks. Zero dependencies on purpose:
// hooks must work before `pnpm install` has ever run.

import { readFileSync } from "node:fs";

/**
 * Reads the hook input JSON from stdin.
 * @returns {Record<string, any>} Parsed input, or an empty object when stdin is empty or invalid.
 */
export function readInput() {
  try {
    const raw = readFileSync(0, "utf8");
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

/** Project root as given by Claude Code, falling back to the current directory. */
export function projectDir(input = {}) {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}

/**
 * Applies a policy decision for a PreToolUse hook and exits.
 * - deny: exit 2, reason on stderr (blocks the tool call, Claude sees the reason)
 * - ask:  JSON permissionDecision "ask" (user is prompted)
 * - allow: exit 0 with no output (normal permission flow continues)
 * @param {{decision: "allow"|"deny"|"ask", reason?: string}} result
 */
export function finishPreToolUse(result) {
  if (result.decision === "deny") {
    process.stderr.write(`[qajitsu guard] ${result.reason}\n`);
    process.exit(2);
  }
  if (result.decision === "ask") {
    process.stdout.write(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "ask",
          permissionDecisionReason: `[qajitsu guard] ${result.reason}`,
        },
      }),
    );
  }
  process.exit(0);
}

/** Normalises a path to forward slashes so checks work on Windows too. */
export function normalizePath(p = "") {
  return String(p).replace(/\\/g, "/");
}

/** Returns the path relative to the project root when it is inside it, otherwise the normalised absolute path. */
export function relativeToProject(filePath, root) {
  const file = normalizePath(filePath);
  const base = normalizePath(root).replace(/\/+$/, "");
  return file.startsWith(`${base}/`) ? file.slice(base.length + 1) : file;
}
