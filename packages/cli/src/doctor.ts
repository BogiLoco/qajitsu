import type { ToolVersion } from "./versions.js";
/** Result of one environment check (REQ-GEN-03). */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
  /** A problem that does not fail doctor (REQ-GEN-08/AC3): shown with `!`, the exit code stays 0. */
  readonly warning?: boolean;
}

/**
 * Tools whose absence a project check already reports (REQ-GEN-08/AC1): a missing Android SDK means a missing
 * emulator too, a missing Appium means missing drivers, a missing Docker means a missing Compose.
 */
const COVERED_BY: Readonly<Record<string, string>> = {
  "android sdk": "android",
  emulator: "android",
  "appium uiautomator2": "appium",
  "appium xcuitest": "appium",
  compose: "docker",
};

/**
 * The failed check that already reports a missing tool, if any (REQ-GEN-08/AC1): the tool's own name, or the check
 * that covers it.
 *
 * @param tool - Tool name of the versions table, e.g. `android sdk`.
 * @param checks - Checks so far.
 */
export function reportedBy(tool: string, checks: readonly DoctorCheck[]): string | undefined {
  const failed = (name: string | undefined) => checks.some((c) => c.name === name && !c.ok);
  if (failed(tool)) return tool;
  const cover = COVERED_BY[tool];
  return failed(cover) ? cover : undefined;
}

/**
 * Checks for the tools a project needs and does not have (REQ-GEN-08/AC1), skipping those an earlier check already
 * reports. `qj doctor` and `qj init` use the same list, so both name the same problems.
 *
 * @param tools - Versions of the tools, with whether the project needs each.
 * @param checks - Checks so far.
 */
export function missingToolChecks(
  tools: readonly ToolVersion[],
  checks: readonly DoctorCheck[],
): DoctorCheck[] {
  return tools
    .filter(
      (t) =>
        t.needed &&
        t.version === undefined &&
        !checks.some((c) => c.name === t.name) &&
        reportedBy(t.name, checks) === undefined,
    )
    .map((t) => ({
      name: t.name,
      ok: false,
      detail: `not found (needed for ${t.why ?? "this project"})${t.install ? `; install: ${t.install}` : ""}`,
    }));
}

/**
 * Warns when a file with secret values can be read by other users of the machine (REQ-GEN-08/AC3). Only the mode is
 * looked at, never the content; Windows has no such mode bits and is skipped.
 *
 * @param input - Path, its mode (`stat().mode`) and the platform.
 * @returns A warning, or nothing when the file is private.
 */
export function secretFileCheck(input: {
  readonly path: string;
  readonly mode: number;
  readonly platform: string;
}): DoctorCheck | undefined {
  if (input.platform === "win32" || (input.mode & 0o077) === 0) return undefined;
  return {
    name: "secrets file",
    ok: true,
    warning: true,
    detail: `${input.path} can be read by other users of this machine (mode ${(input.mode & 0o777).toString(8)}); fix: chmod 600 ${input.path}`,
  };
}

/** Inputs for the checks, injected so the function stays pure and testable. */
export interface DoctorInput {
  readonly nodeVersion: string;
  readonly hasProjectConfig: boolean;
}

const MIN_NODE = [22, 12] as const;

/**
 * Runs the environment checks available in this roadmap stage. Later stages add Jira, code host,
 * Docker, emulator and model capability checks (REQ-GEN-03, REQ-LLM-03).
 */
export function runDoctor(input: DoctorInput): DoctorCheck[] {
  const [major = 0, minor = 0] = input.nodeVersion.replace(/^v/, "").split(".").map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  return [
    {
      name: "node",
      ok: nodeOk,
      detail: nodeOk
        ? `Node.js ${input.nodeVersion}`
        : `Node.js ${input.nodeVersion}; need >= ${MIN_NODE.join(".")}`,
    },
    {
      name: "project config",
      ok: input.hasProjectConfig,
      detail: input.hasProjectConfig
        ? ".qa/qa.project.yaml found"
        : ".qa/qa.project.yaml not found; 'qajitsu init' will create it (REQ-GEN-03)",
    },
  ];
}

/** Formats checks for the terminal: one line per check, ✔ passed, ! warning, ✘ failed. */
export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks
    .map((c) => `${c.ok ? (c.warning === true ? "!" : "✔") : "✘"} ${c.name}: ${c.detail}`)
    .join("\n");
}
