/** Result of one environment check (REQ-GEN-03). */
export interface DoctorCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
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

/** Formats checks for the terminal: one line per check. */
export function formatDoctor(checks: readonly DoctorCheck[]): string {
  return checks.map((c) => `${c.ok ? "✔" : "✘"} ${c.name}: ${c.detail}`).join("\n");
}
