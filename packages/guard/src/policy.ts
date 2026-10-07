import { posix } from "node:path";

/** An agent's request to use a tool, before it runs. */
export interface ToolCall {
  readonly tool: string;
  readonly input: Readonly<Record<string, unknown>>;
}

/** Why a tool call was denied. Stable codes for journals and tests. */
export type DenyCode =
  "UNKNOWN_TOOL" | "OUTSIDE_WORKSPACE" | "PROTECTED_PATH" | "MISSING_PATH" | "URL_NOT_ALLOWED";

/** Result of evaluating a tool call. */
export type GuardDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly code: DenyCode; readonly reason: string };

/** What a stage's agent may do (REQ-VER-03, REQ-ENV-01, invariant 10). */
export interface GuardPolicy {
  /** Absolute path of the run workspace; file tools may not leave it. */
  readonly workspaceRoot: string;
  /** Tool names the agent of this stage may call; anything else is denied (default deny). */
  readonly allowedTools: ReadonlySet<string>;
  /** Tools that write, delete or move files; their `path` (and `to`) inputs are checked. */
  readonly writeTools: ReadonlySet<string>;
  /** Workspace-relative paths agents may never write; a trailing `/` protects a directory. */
  readonly protectedPaths: readonly string[];
  /**
   * Tools that read files; their `path` input must stay inside the workspace (REQ-PRJ-04/AC1). Optional: the
   * tools also confine themselves; the guard makes the denial visible in the journal.
   */
  readonly readTools?: ReadonlySet<string>;
  /** Tools whose `url` input must match the allowlist. */
  readonly networkTools: ReadonlySet<string>;
  /** Allowed URL origins, e.g. `https://staging.example.com`. */
  readonly allowedOrigins: readonly string[];
}

/** Paths no agent may write in any stage (invariants 2 and 3). */
export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  "results/",
  "evidence/",
  // Plan versions are written by QAJitsu from validated planner output, never by agent tools.
  "plan/",
  "journal/",
  // Auditor and canary records: written by the orchestrator, they can only downgrade (REQ-VER-06, REQ-VER-09).
  "checks/",
  // Exploratory sessions: actions, observations and recordings are written by the trusted parent (REQ-EXEC-15/AC2).
  "explore/",
  // Documentation chunks agents were given; plan quotes are checked against them (REQ-KNOW-06/AC3).
  "knowledge/",
  // Manual step requests and a person's answers (REQ-EXEC-11/AC4): agents can never answer for a tester.
  "manual/",
  // Imported manual test cases (REQ-CTX-08): plan citations are checked against them.
  "imported/",
  // The application map around the change (REQ-OBS-08): plan citations are checked against it.
  "map/",
  "run.json",
];

const ALLOW: GuardDecision = { allowed: true };

const deny = (code: DenyCode, reason: string): GuardDecision => ({ allowed: false, code, reason });

const toPosix = (p: string): string => p.replace(/\\/g, "/");

/**
 * Resolves a tool-provided path inside the workspace.
 * @returns The workspace-relative path, or `undefined` when it escapes the workspace.
 */
export function resolveInWorkspace(workspaceRoot: string, path: string): string | undefined {
  const root = posix.resolve(toPosix(workspaceRoot));
  const absolute = posix.resolve(root, toPosix(path));
  if (absolute === root) return "";
  if (!absolute.startsWith(`${root}/`)) return undefined;
  return absolute.slice(root.length + 1);
}

function isProtected(relative: string, protectedPaths: readonly string[]): boolean {
  // Case-insensitive: macOS and Windows file systems treat `Results/` and `results/` as one folder.
  const rel = relative.toLowerCase();
  return protectedPaths.some((raw) => {
    const p = raw.toLowerCase();
    return p.endsWith("/") ? rel === p.slice(0, -1) || rel.startsWith(p) : rel === p;
  });
}

function checkPath(policy: GuardPolicy, value: unknown, field: string): GuardDecision {
  if (typeof value !== "string" || value.length === 0) {
    return deny("MISSING_PATH", `Tool input '${field}' must be a non-empty path.`);
  }
  const relative = resolveInWorkspace(policy.workspaceRoot, value);
  if (relative === undefined)
    return deny("OUTSIDE_WORKSPACE", `Path '${value}' is outside the run workspace.`);
  if (isProtected(relative, policy.protectedPaths)) {
    return deny("PROTECTED_PATH", `'${relative}' is written only by runners and QAJitsu itself.`);
  }
  return ALLOW;
}

function checkUrl(policy: GuardPolicy, value: unknown): GuardDecision {
  if (typeof value !== "string") return deny("URL_NOT_ALLOWED", "Tool input 'url' must be a string.");
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    return deny("URL_NOT_ALLOWED", `'${value}' is not a valid URL.`);
  }
  return policy.allowedOrigins.includes(origin)
    ? ALLOW
    : deny("URL_NOT_ALLOWED", `Origin '${origin}' is not on the environment allowlist.`);
}

/**
 * Decides whether an agent tool call may run. Pure function: default deny, no LLM involvement
 * (REQ-VER-03, invariants 2 and 10).
 *
 * @param call - The tool call the agent requested.
 * @param policy - The policy of the current stage.
 * @returns `allowed: true`, or a denial with a stable code and a reason for the journal.
 */
export function evaluateToolCall(call: ToolCall, policy: GuardPolicy): GuardDecision {
  if (!policy.allowedTools.has(call.tool)) {
    return deny("UNKNOWN_TOOL", `Tool '${call.tool}' is not available in this stage.`);
  }
  if (policy.writeTools.has(call.tool)) {
    const target = checkPath(policy, call.input["path"], "path");
    if (!target.allowed) return target;
    if ("to" in call.input) return checkPath(policy, call.input["to"], "to");
  }
  if (policy.readTools?.has(call.tool) === true && typeof call.input["path"] === "string") {
    if (resolveInWorkspace(policy.workspaceRoot, call.input["path"]) === undefined)
      return deny("OUTSIDE_WORKSPACE", `Path '${call.input["path"]}' is outside the run workspace.`);
  }
  if (policy.networkTools.has(call.tool)) return checkUrl(policy, call.input["url"]);
  return ALLOW;
}
