import type { AgentTool } from "@qajitsu/agents";

/**
 * Makes an explorer's tools run one at a time, in the order the agent asked for them (REQ-EXEC-15/AC9). A model may
 * ask for several actions in one turn and the agent loop runs those calls concurrently; one browser, one sandbox and
 * one numbering of actions need them in sequence, so each gets its own id, evidence and place in the live view.
 *
 * @param tools - The session's tools.
 * @returns The same tools, sharing one queue.
 */
export function oneAtATime(tools: readonly AgentTool[]): AgentTool[] {
  let queue: Promise<unknown> = Promise.resolve();
  return tools.map((tool) => ({
    ...tool,
    execute(input, signal) {
      const run = queue.then(() => tool.execute(input, signal));
      queue = run.catch(() => undefined);
      return run;
    },
  }));
}
