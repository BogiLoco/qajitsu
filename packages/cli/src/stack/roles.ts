import { AGENT_ROLES, missingCapabilities } from "@qajitsu/agents";
import { MODEL_ROLES } from "@qajitsu/models";
import type { ModelFacts } from "./inspect.js";
import { STACK_PROVIDER } from "./project-patch.js";

/**
 * The model of every role once the stack's roles are set (REQ-LLM-02): the stack's own entry, then the project's, each
 * with its `default`. A role without a model is left out.
 *
 * @param project - `models.roles` of the project.
 * @param stack - `role` (or `default`) to Ollama model, set by the stack.
 * @returns `role` to `<provider>/<model>`.
 */
export function effectiveRoles(
  project: Readonly<Record<string, string>>,
  stack: Readonly<Record<string, string>>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const role of MODEL_ROLES) {
    const own = stack[role] ?? (project[role] === undefined ? stack["default"] : undefined);
    const ref = own !== undefined ? `${STACK_PROVIDER}/${own}` : (project[role] ?? project["default"]);
    if (ref !== undefined) out[role] = ref;
  }
  return out;
}

/**
 * The context length the stack's Ollama is started with (`OLLAMA_CONTEXT_LENGTH`): the largest any role it serves
 * needs, so a model is never cut below what its role was checked for.
 *
 * @param roles - From {@link effectiveRoles}.
 */
export function stackContextLength(roles: Readonly<Record<string, string>>): number {
  let need = 32_768;
  for (const [role, ref] of Object.entries(roles))
    if (ref.startsWith(`${STACK_PROVIDER}/`)) {
      const required = AGENT_ROLES.find((r) => r.role === role)?.requires.contextWindow ?? 0;
      if (required > need) need = required;
    }
  return need <= 32_768 ? 32_768 : need <= 65_536 ? 65_536 : 131_072;
}

/**
 * What stops the stack's models from serving their roles (REQ-GEN-10/AC3, REQ-LLM-03): a capability a model lacks
 * (checked like `qajitsu doctor --models`, with the context the stack gives it), and an auditor reviewing with the
 * author's model (REQ-VER-06). Roles the project switched off are not checked.
 *
 * @param input - The effective roles, what each stack model can do, the stack's context length, roles switched off.
 * @returns One line per problem; empty when every role is served.
 */
export function stackRoleProblems(input: {
  readonly roles: Readonly<Record<string, string>>;
  readonly facts: ReadonlyMap<string, ModelFacts>;
  readonly contextLength: number;
  readonly off: ReadonlySet<string>;
}): string[] {
  const problems: string[] = [];
  const prefix = `${STACK_PROVIDER}/`;
  for (const [role, ref] of Object.entries(input.roles)) {
    if (input.off.has(role) || !ref.startsWith(prefix)) continue;
    const name = ref.slice(prefix.length);
    const facts = input.facts.get(name);
    const definition = AGENT_ROLES.find((r) => r.role === role);
    if (!facts || !definition) continue;
    const missing = missingCapabilities(definition, {
      tools: facts.tools,
      // Ollama constrains every model's output to a JSON schema.
      structuredOutput: true,
      vision: facts.vision,
      contextWindow: Math.min(facts.contextWindow, input.contextLength),
    });
    if (missing.length > 0) problems.push(`${role}: ${name} lacks ${missing.join(", ")}`);
  }
  const author = input.roles["author"];
  if (!input.off.has("auditor") && author !== undefined && input.roles["auditor"] === author)
    problems.push(
      `auditor: ${author} is the author's model; the auditor reviews with another one (REQ-VER-06)`,
    );
  return problems;
}
