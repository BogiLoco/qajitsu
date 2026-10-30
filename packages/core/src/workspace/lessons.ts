import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseEventLines } from "../events/event-log.js";
import { listTickets } from "./maintenance.js";
import { readRunIndex } from "./run-workspace.js";

/**
 * What a person taught QAJitsu in an earlier run of the project (REQ-CTX-20/AC5): a FAILED case that was not a product
 * bug, a defect that escaped a passed run, or a change a person asked of a plan. Written by people, so untrusted data.
 */
export interface Lesson {
  readonly ticket: string;
  readonly run: string;
  readonly at: string;
  readonly kind: "false-failed" | "escaped" | "revision";
  readonly text: string;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** The lessons of one run: its feedback in `run.json` and the revisions people asked for in its journal. */
async function lessonsOfRun(dir: string, ticket: string, run: string): Promise<Lesson[]> {
  const out: Lesson[] = [];
  const record = asRecord(JSON.parse(await readFile(join(dir, "run.json"), "utf8").catch(() => "{}")));
  const feedback = asRecord(asRecord(record["data"])["feedback"]);
  for (const [id, raw] of Object.entries(asRecord(feedback["cases"]))) {
    const f = asRecord(raw);
    if (f["is"] === "product-bug") continue;
    const note = str(f["note"]);
    out.push({
      ticket,
      run,
      at: str(f["at"]),
      kind: "false-failed",
      text: `Case ${id} FAILED, but a person found it was a ${str(f["is"])} problem, not a product bug${note ? `: ${note}` : "."}`,
    });
  }
  for (const raw of Array.isArray(feedback["escaped"]) ? (feedback["escaped"] as unknown[]) : []) {
    const f = asRecord(raw);
    const note = str(f["note"]);
    out.push({
      ticket,
      run,
      at: str(f["at"]),
      kind: "escaped",
      text: `Defect ${str(f["bug"])} was found later although this run passed${note ? `: ${note}` : "."}`,
    });
  }
  const journal = await readFile(join(dir, "journal", "events.jsonl"), "utf8").catch(() => "");
  for (const e of parseEventLines(journal).events)
    if (e.event === "plan.revision_requested") {
      const instruction = str(asRecord(e.details)["instruction"]).trim();
      if (instruction)
        out.push({
          ticket,
          run,
          at: e.ts,
          kind: "revision",
          text: `A person asked the planner to change the plan: ${instruction}`,
        });
    }
  return out;
}

/**
 * Lessons of earlier runs of the project (REQ-CTX-20/AC5), newest first: false FAILED reported with `qj feedback`,
 * escaped defects and plan revisions people asked for. Runs that cannot be read are skipped; texts are cut to 500
 * characters (they are already masked when recorded).
 *
 * @param root - Workspace root.
 * @param options - The current run (left out) and how many lessons at most.
 */
export async function collectLessons(
  root: string,
  options: { readonly exclude?: string; readonly limit?: number } = {},
): Promise<Lesson[]> {
  const all: Lesson[] = [];
  for (const ticket of await listTickets(root)) {
    const index = await readRunIndex(root, ticket).catch(() => undefined);
    for (const r of index?.runs ?? []) {
      if (r.runId === options.exclude) continue;
      all.push(...(await lessonsOfRun(join(root, ticket, r.runId), ticket, r.runId).catch(() => [])));
    }
  }
  return all
    .map((l) => ({ ...l, text: l.text.slice(0, 500) }))
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.run < b.run ? -1 : 1))
    .slice(0, options.limit ?? 20);
}
