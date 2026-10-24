import { readFile } from "node:fs/promises";
import { parseEventLines } from "@qajitsu/core";
import { formatDuration, runTiming, stagesOverBudget } from "@qajitsu/report";
import type { CommandIO } from "./commands/fetch.js";
import type { RunSession } from "./session.js";

/**
 * Warns about the stages of a command that took longer than their budget (REQ-NFR-11/AC3) and journals it under the
 * `timing` stage, which no stage span counts. A budget never changes a status.
 *
 * @param session - The run.
 * @param io - Terminal.
 * @param stages - The stages the command ran, e.g. `["analyze", "plan"]`.
 */
export async function warnStageBudgets(
  session: Pick<RunSession, "ws" | "events" | "project">,
  io: Pick<CommandIO, "writeError">,
  stages: readonly string[],
): Promise<void> {
  const text = await readFile(session.ws.path("journal", "events.jsonl"), "utf8").catch(() => "");
  const over = stagesOverBudget(
    runTiming(parseEventLines(text).events),
    stages,
    session.project.config.timing.budgets_s,
  );
  for (const o of over) {
    session.events.emit("timing", { kind: "system", name: "orchestrator" }, "stage.over_budget", {
      stage: o.stage,
      ms: o.ms,
      budgetS: o.budgetS,
    });
    io.writeError(
      `Warning: stage ${o.stage} took ${formatDuration(o.ms)}, over its budget of ${formatDuration(o.budgetS * 1000)} (timing.budgets_s.${o.stage}); no status is affected.\n`,
    );
  }
}
