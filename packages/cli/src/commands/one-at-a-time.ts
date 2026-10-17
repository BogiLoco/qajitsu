import type { AgentTool } from "@qajitsu/agents";

/**
 * Makes an explorer's tools run one at a time, in the order the agent asked for them (REQ-EXEC-15/AC9). A model may
 * ask for several actions in one turn and the agent loop runs those calls concurrently; one browser, one sandbox and
 * one numbering of actions need them in sequence, so each gets its own id, evidence and place in the live view.
 *
 * Calls still queued when the session is aborted do not start.
 *
 * @param tools - The session's tools.
 * @returns The same tools, sharing one queue.
 */
export function oneAtATime(tools: readonly AgentTool[]): AgentTool[] {
  let queue: Promise<unknown> = Promise.resolve();
  return tools.map((tool) => ({
    ...tool,
    execute(input, signal) {
      // REQ-EXEC-15/AC5: after the time box or a stop, calls still waiting in the queue never start.
      const run = queue.then(() =>
        signal?.aborted === true
          ? "ABORTED: the session ended (time box or stopped); no further actions run."
          : tool.execute(input, signal),
      );
      queue = run.catch(() => undefined);
      return run;
    },
  }));
}
