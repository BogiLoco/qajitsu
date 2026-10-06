import type { ModelCapabilities } from "@qajitsu/core";

/** Definition of one agent role: what it does, which tools it gets and what its model must support. */
export interface AgentRoleDefinition {
  readonly role: "analyst" | "planner" | "author" | "healer" | "auditor" | "explorer";
  readonly purpose: string;
  /** Tool names allowed for this role; everything else is denied by the guard (REQ-VER-03). */
  readonly tools: readonly string[];
  /** Minimum model capabilities (REQ-LLM-03). */
  readonly requires: Partial<ModelCapabilities>;
  /** Requirement IDs this role implements. */
  readonly requirements: readonly string[];
}

/** Role catalogue. Prompts and loop wiring arrive in roadmap stage 2 (REQ-PLAN-01, REQ-PLAN-02). */
export const AGENT_ROLES: readonly AgentRoleDefinition[] = [
  {
    role: "analyst",
    purpose:
      "Classify the change (api/web/mobile/mixed), find affected endpoints and screens, list regression risks.",
    tools: ["read_file", "search_code", "list_files", "search_docs"],
    requires: { tools: true, structuredOutput: true, contextWindow: 64_000 },
    requirements: ["REQ-PLAN-01", "REQ-CTX-05", "REQ-KNOW-06"],
  },
  {
    role: "planner",
    purpose: "Write the structured test plan with grounded sources and open questions.",
    tools: ["read_file", "search_code", "list_files", "search_docs", "write_plan"],
    requires: { tools: true, structuredOutput: true, contextWindow: 64_000 },
    requirements: ["REQ-PLAN-02", "REQ-PLAN-03", "REQ-PLAN-05", "REQ-KNOW-06"],
  },
  {
    role: "author",
    purpose:
      "Turn approved cases into executable specs using @qajitsu/steps; explore the app through MCP for selectors.",
    tools: ["read_file", "search_code", "list_files", "write_file", "browser_navigate", "browser_snapshot"],
    requires: { tools: true, structuredOutput: true, contextWindow: 128_000 },
    requirements: ["REQ-EXEC-01", "REQ-EXEC-02"],
  },
  {
    role: "healer",
    purpose: "Fix selectors and waits in failing specs only; assertions are locked.",
    tools: ["read_file", "write_file", "browser_snapshot"],
    requires: { tools: true, contextWindow: 64_000 },
    requirements: ["REQ-EXEC-09"],
  },
  {
    role: "auditor",
    purpose: "Independently compare plan, results and evidence; can only downgrade PASSED to NEEDS_REVIEW.",
    tools: ["read_file", "list_files", "view_image"],
    requires: { tools: true, structuredOutput: true, vision: true, contextWindow: 128_000 },
    requirements: ["REQ-VER-06"],
  },
  {
    role: "explorer",
    purpose:
      "Explore the application towards a session goal through browser actions the trusted parent performs and records; report observations, never statuses.",
    tools: [
      "explore_look",
      "explore_goto",
      "explore_click",
      "explore_fill",
      "explore_select",
      "explore_press",
      "explore_back",
      "explore_login_as",
      "record_observation",
    ],
    requires: { tools: true, structuredOutput: true, contextWindow: 64_000 },
    requirements: ["REQ-EXEC-15"],
  },
];

/**
 * Checks whether a model satisfies a role's requirements (used by `qajitsu doctor`, REQ-LLM-03).
 *
 * @returns Names of the missing capabilities; empty when the model fits.
 */
export function missingCapabilities(role: AgentRoleDefinition, model: ModelCapabilities): string[] {
  const missing: string[] = [];
  if (role.requires.tools === true && !model.tools) missing.push("tools");
  if (role.requires.structuredOutput === true && !model.structuredOutput) missing.push("structuredOutput");
  if (role.requires.vision === true && !model.vision) missing.push("vision");
  if (role.requires.contextWindow !== undefined && model.contextWindow < role.requires.contextWindow) {
    missing.push(`contextWindow>=${role.requires.contextWindow}`);
  }
  return missing;
}
