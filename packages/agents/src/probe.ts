import type { ModelRegistry, ModelRole } from "@qajitsu/models";
import { MODEL_ROLES } from "@qajitsu/models";
import { generateText, stepCountIs, tool } from "ai";
import { z } from "zod";
import { AGENT_ROLES, missingCapabilities } from "./roles.js";

/** Result of probing the model of one role (REQ-LLM-03/AC2). */
export interface ModelProbe {
  /** The role, or `approver` for the model step of the plan approval flow (REQ-PLAN-10). */
  readonly role: ModelRole | "approver";
  readonly model: string;
  readonly reachable: boolean;
  /** Whether the model actually called a tool when asked to; undefined when not probed. */
  readonly toolCalls?: boolean;
  /** Capabilities the role needs that the model's profile lacks. */
  readonly missing: readonly string[];
  readonly error?: string;
}

/**
 * Probes the configured model of every role: one tiny call that must use a tool, plus the capability
 * profile check against the role's requirements (REQ-LLM-03/AC2). Makes real model calls.
 *
 * @param models - Model registry.
 * @param roles - Configured role names (keys of `models.roles`), `default` expands to unassigned roles.
 * @param signal - Cancels the probes.
 * @param approver - The model reference of `approval.model`, probed as the `approver` (REQ-PLAN-10, REQ-GEN-08).
 */
export async function probeModels(
  models: ModelRegistry,
  roles: readonly string[],
  signal?: AbortSignal,
  approver?: string,
): Promise<ModelProbe[]> {
  const wanted: (ModelRole | "approver")[] = [
    ...(roles.includes("default") ? MODEL_ROLES : MODEL_ROLES.filter((r) => roles.includes(r))),
    ...(approver === undefined ? [] : (["approver"] as const)),
  ];
  const results: ModelProbe[] = [];
  for (const role of wanted) {
    let id = "?";
    try {
      const resolved =
        role === "approver" ? await models.resolve(approver ?? "") : await models.forRole(role);
      id = resolved.id;
      const def = AGENT_ROLES.find((r) => r.role === role);
      // ADR-0010: the approver checks the planner's work, so it must be another model (REQ-PLAN-10/AC2).
      const planner = role === "approver" ? (await models.forRole("planner")).id : undefined;
      const missing = [
        ...(def ? missingCapabilities(def, resolved.profile) : []),
        ...(planner === resolved.id ? [`another model than the planner (both are ${planner})`] : []),
      ];
      let called = false as boolean;
      await generateText({
        model: resolved.model,
        prompt: "Call the ping tool once with value 'ok', then answer with the word done.",
        tools: {
          ping: tool({
            description: "Health check",
            inputSchema: z.object({ value: z.string() }),
            execute: () => {
              called = true;
              return Promise.resolve("pong");
            },
          }),
        },
        stopWhen: stepCountIs(3),
        maxRetries: 0,
        ...(signal ? { abortSignal: signal } : {}),
      });
      const toolMissing =
        def?.requires.tools === true && !called && !missing.includes("tools")
          ? ["tools (did not call the probe tool)"]
          : [];
      results.push({
        role,
        model: id,
        reachable: true,
        toolCalls: called,
        missing: [...missing, ...toolMissing],
      });
    } catch (error) {
      results.push({
        role,
        model: id,
        reachable: false,
        missing: [],
        error: error instanceof Error ? (error.message.split("\n")[0] ?? "error") : String(error),
      });
    }
  }
  return results;
}

/** Formats probe results for the terminal; every line starts with ✔ or ✘. */
export function formatProbes(probes: readonly ModelProbe[]): string {
  return probes
    .map((p) => {
      const ok = p.reachable && p.missing.length === 0;
      const detail = !p.reachable
        ? `unreachable: ${p.error ?? ""}`
        : p.missing.length > 0
          ? `missing ${p.missing.join(", ")}`
          : `ok${p.toolCalls ? ", tool calls work" : ""}`;
      return `${ok ? "✔" : "✘"} ${p.role}: ${p.model} ${detail}`;
    })
    .join("\n");
}
