import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  APPROVED_PLAN_FILE,
  CaseResultFileSchema,
  NETWORK_ANALYSIS_FILE,
  NetworkAnalysisSchema,
  readRunIndex,
  sha256,
  type NetworkAnalysis,
  type RunWorkspace,
} from "@qajitsu/core";

/** The traffic analysis of every case's last attempt in one run folder. */
async function analysesOf(dir: string): Promise<Map<string, NetworkAnalysis>> {
  const out = new Map<string, NetworkAnalysis>();
  const files = await readdir(join(dir, "results")).catch(() => [] as string[]);
  for (const file of files.filter((f) => f.endsWith(".json"))) {
    try {
      const result = CaseResultFileSchema.parse(
        JSON.parse(await readFile(join(dir, "results", file), "utf8")),
      );
      const path = result.attempts.at(-1)?.evidence.find((p) => p.endsWith(`/${NETWORK_ANALYSIS_FILE}`));
      if (path === undefined) continue;
      const parsed = NetworkAnalysisSchema.safeParse(
        JSON.parse(await readFile(join(dir, "evidence", path), "utf8")),
      );
      if (parsed.success) out.set(result.caseId, parsed.data);
    } catch {
      // A result or analysis that cannot be read is left out: there is nothing to compare it with.
    }
  }
  return out;
}

/**
 * The traffic of the last earlier run of the same approved plan (REQ-EVD-09/AC4+AC5): the newest run of the ticket
 * before this one whose `plan.approved.yaml` has the same SHA-256, with each case's traffic analysis. Undefined when no
 * earlier run ran that plan.
 *
 * @param ws - This run.
 */
export async function earlierNetwork(
  ws: Pick<RunWorkspace, "root" | "ticket" | "runId" | "path">,
): Promise<{ readonly runId: string; readonly byCase: Map<string, NetworkAnalysis> } | undefined> {
  const mine = await readFile(ws.path("plan", APPROVED_PLAN_FILE), "utf8").catch(() => undefined);
  if (mine === undefined) return undefined;
  const plan = sha256(mine);
  const index = await readRunIndex(ws.root, ws.ticket).catch(() => undefined);
  const runs = index?.runs ?? [];
  const at = runs.findIndex((r) => r.runId === ws.runId);
  for (const run of runs.slice(0, at < 0 ? runs.length : at).reverse()) {
    const dir = join(ws.root, ws.ticket, run.runId);
    const theirs = await readFile(join(dir, "plan", APPROVED_PLAN_FILE), "utf8").catch(() => undefined);
    if (theirs === undefined || sha256(theirs) !== plan) continue;
    return { runId: run.runId, byCase: await analysesOf(dir) };
  }
  return undefined;
}
