import type { Journal } from "./journal.js";
import { evaluateToolCall, type GuardDecision, type GuardPolicy, type ToolCall } from "./policy.js";

/** Guard bound to one run and stage. */
export interface Guard {
  /** Evaluates a tool call and journals the decision. Call before executing any agent tool. */
  check(call: ToolCall): GuardDecision;
  /** Journals a short summary of what an allowed tool call returned (REQ-VER-04/AC2). */
  recordResult(call: ToolCall, summary: string): void;
}

/**
 * Creates the guard used by the agent loop for one stage (REQ-VER-03, REQ-VER-04).
 *
 * @example
 * const guard = createGuard({ run, stage: "author", policy, journal });
 * const decision = guard.check({ tool: "write_file", input: { path: "specs/TC-01.spec.ts" } });
 */
export function createGuard(options: {
  readonly run: string;
  readonly stage: string;
  readonly policy: GuardPolicy;
  readonly journal: Journal;
}): Guard {
  const { run, stage, policy, journal } = options;
  return {
    check(call) {
      const decision = evaluateToolCall(call, policy);
      if (decision.allowed) {
        journal.record({ run, stage, event: "tool_allowed", tool: call.tool, args: call.input });
      } else {
        journal.record({
          run,
          stage,
          event: "tool_denied",
          tool: call.tool,
          code: decision.code,
          reason: decision.reason,
          args: call.input,
        });
      }
      return decision;
    },
    recordResult(call, summary) {
      journal.record({ run, stage, event: "tool_result", tool: call.tool, result: summary });
    },
  };
}
