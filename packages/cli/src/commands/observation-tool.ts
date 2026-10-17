import type { AgentTool } from "@qajitsu/agents";
import { ObservationSchema, type EventLog, type Observation } from "@qajitsu/core";
import { z } from "zod";

const ORCHESTRATOR = { kind: "system", name: "orchestrator" } as const;

/**
 * The `record_observation` tool of an exploratory session (REQ-EXEC-15/AC3, REQ-EXEC-24/AC4): an observation is
 * kept only when its steps are actions of this session, in order; text is masked; it is never a status.
 *
 * @param ctx - Known action ids, the list to add to, masking and the journal.
 */
export function createObservationTool(ctx: {
  readonly knownIds: () => ReadonlySet<string>;
  readonly observations: Observation[];
  readonly mask: (text: string) => string;
  readonly events: EventLog;
}): AgentTool {
  const refuse = (reason: string): string => {
    ctx.events.emit("explore", ORCHESTRATOR, "explore.refused", { tool: "record_observation", reason });
    return `REFUSED: ${reason}`;
  };
  return {
    name: "record_observation",
    description:
      "Record something a person should look at: title, kind, severity, description, expected, actual and the action ids that reproduce it.",
    inputSchema: z.object({
      title: z.string(),
      kind: z.enum(["possible-bug", "ux", "question", "risk"]),
      severity: z.enum(["low", "medium", "high"]),
      description: z.string(),
      steps: z.array(z.string()),
      expected: z.string().optional(),
      actual: z.string().optional(),
    }),
    execute(input) {
      const steps = (input["steps"] as unknown[]).map(String);
      const known = ctx.knownIds();
      const unknown = steps.filter((s) => !known.has(s));
      if (steps.length === 0 || unknown.length > 0)
        return Promise.resolve(
          refuse(`steps must be action ids of this session (unknown: ${unknown.join(", ") || "none given"})`),
        );
      const parsed = ObservationSchema.safeParse({
        id: `O${String(ctx.observations.length + 1)}`,
        title: ctx.mask(String(input["title"])),
        kind: input["kind"],
        severity: input["severity"],
        description: ctx.mask(String(input["description"])),
        steps,
        expected: ctx.mask(typeof input["expected"] === "string" ? input["expected"] : ""),
        actual: ctx.mask(typeof input["actual"] === "string" ? input["actual"] : ""),
      });
      if (!parsed.success)
        return Promise.resolve(
          refuse(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")),
        );
      ctx.observations.push(parsed.data);
      ctx.events.emit("explore", ORCHESTRATOR, "explore.observation", {
        id: parsed.data.id,
        kind: parsed.data.kind,
        severity: parsed.data.severity,
        steps,
      });
      return Promise.resolve(`${parsed.data.id} recorded.`);
    },
  };
}
