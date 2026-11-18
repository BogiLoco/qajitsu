import { createHash, randomBytes } from "node:crypto";
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BudgetError,
  fileSpendLedger,
  monthOf,
  parseEventLines,
  processAlive,
  readHolder,
  readRunIndex,
  SPEND_LEDGER_FILE,
  SpendEntrySchema,
  TicketKeySchema,
  ticketVersion,
  TicketSnapshotSchema,
  type SpendEntry,
} from "@qajitsu/core";
import { runTiming } from "@qajitsu/report";
import { z } from "zod";
import type { LoadedProject } from "./project.js";

/** What a run's journal proves about its ledger entries. */
interface RunProof {
  /** SHA-256 of the sorted model calls, each with its month, stage, role, model, cases, tokens and cost. */
  readonly fingerprint: string;
  readonly calls: number;
  readonly tokens: number;
  readonly activeMs: number;
}

/** A run on disk with a ticket snapshot, the only runs whose spend the journals can prove. */
interface DiskRun {
  readonly ticket: string;
  readonly runId: string;
  readonly dir: string;
  readonly version: string;
  readonly project: string;
  readonly active: boolean;
}

const CACHE_FILE = "budget/journals.json";
/** Proofs by run, valid only for the journal content with the given SHA-256. */
const CacheSchema = z.record(
  z.string(),
  z.strictObject({
    journalSha256: z.string(),
    fingerprint: z.string(),
    calls: z.number(),
    tokens: z.number(),
    activeMs: z.number(),
  }),
);

/** The proof of a run's entries; the month of each call is taken in the project's time zone. */
const proofOf = (entries: readonly SpendEntry[], timeZone: string): RunProof => {
  const calls = entries.flatMap((e) =>
    e.kind === "model"
      ? [
          JSON.stringify([
            monthOf(new Date(e.ts), timeZone),
            e.stage,
            e.role,
            e.model,
            e.caseIds,
            e.apportioned === true,
            e.inputTokens,
            e.cachedInputTokens,
            e.outputTokens,
            e.costUsd,
          ]),
        ]
      : [],
  );
  return {
    fingerprint: createHash("sha256").update(calls.sort().join("\n")).digest("hex"),
    calls: calls.length,
    tokens: entries.reduce(
      (n, e) => n + (e.kind === "model" ? e.inputTokens + e.cachedInputTokens + e.outputTokens : 0),
      0,
    ),
    activeMs: entries.reduce((n, e) => n + (e.kind === "runtime" ? e.activeMs : 0), 0),
  };
};

/** Every run of the project on disk that has a ticket snapshot. */
async function diskRuns(project: LoadedProject, root: string): Promise<DiskRun[]> {
  const tickets = (await readdir(root, { withFileTypes: true }).catch(() => []))
    .filter((d) => d.isDirectory() && TicketKeySchema.safeParse(d.name).success)
    .map((d) => TicketKeySchema.parse(d.name));
  const runs: DiskRun[] = [];
  for (const ticket of tickets) {
    const index = await readRunIndex(root, ticket).catch(() => ({ runs: [] }));
    for (const { runId } of index.runs) {
      const dir = join(root, ticket, runId);
      let version: string;
      try {
        version = ticketVersion(
          TicketSnapshotSchema.parse(JSON.parse(await readFile(join(dir, "ticket", "ticket.json"), "utf8"))),
        );
      } catch {
        continue;
      }
      let record: { data?: { project?: unknown } } = {};
      try {
        record = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as typeof record;
      } catch {
        // An unreadable run record names no project; the project's own slug is used.
      }
      const pid = await readHolder(join(dir, "run.lock"));
      runs.push({
        ticket,
        runId,
        dir,
        version,
        project:
          typeof record.data?.project === "string"
            ? record.data.project
            : (project.project?.slug ?? project.config.project),
        active: pid !== undefined && processAlive(pid),
      });
    }
  }
  return runs;
}

/**
 * The ledger entries a run's journal proves (REQ-FLOW-06/AC2): one per model call, with the same attribution, and
 * one with the run's active time.
 */
function journalEntries(run: DiskRun, journal: string): SpendEntry[] {
  const events = parseEventLines(journal).events;
  const base = { project: run.project, ticket: run.ticket, ticketVersion: run.version, runId: run.runId };
  const calls = events.flatMap((e): SpendEntry[] => {
    if (e.event !== "model.usage") return [];
    const d = (e.details ?? {}) as Record<string, unknown>;
    const num = (k: string) => (typeof d[k] === "number" ? d[k] : 0);
    const cached = num("cachedInputTokens");
    return [
      SpendEntrySchema.parse({
        kind: "model",
        ts: e.ts,
        ...base,
        stage: e.stage,
        role: typeof d["role"] === "string" ? d["role"] : e.actor.name,
        model: typeof d["model"] === "string" ? d["model"] : "unknown",
        caseIds: Array.isArray(d["caseIds"]) ? d["caseIds"] : [],
        ...(d["apportioned"] === true ? { apportioned: true } : {}),
        inputTokens: Math.max(0, num("inputTokens") - cached),
        cachedInputTokens: cached,
        outputTokens: num("outputTokens"),
        costUsd: typeof d["costUsd"] === "number" ? d["costUsd"] : null,
      }),
    ];
  });
  const activeMs = Math.round(runTiming(events).activeMs);
  const last = events.at(-1);
  return [
    ...calls,
    ...(activeMs > 0 && last
      ? [SpendEntrySchema.parse({ kind: "runtime", ts: last.ts, ...base, stage: last.stage, activeMs })]
      : []),
  ];
}

/** Writes the journal cache atomically, so parallel commands never leave half a file. */
async function writeCache(file: string, cache: Record<string, unknown>): Promise<void> {
  const temp = `${file}.${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(cache)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, file);
  } catch {
    // The cache is a convenience; without it the journals are read again next time.
  } finally {
    await rm(temp, { force: true });
  }
}

/**
 * Runs on disk whose ledger entries are not what their journals prove (REQ-FLOW-06/AC2): a call missing, added or
 * changed (tokens, cost, case, model, stage, month), an entry booked to another ticket or ticket version, or more
 * active time than the journal holds. Active time the ledger lacks (a command that ended without adding it, a removed
 * line) is added from the journal. Runs still active are skipped; runs no longer on disk keep their ledger spend.
 *
 * @param project - The project.
 * @param root - The project's runs root.
 * @returns One line per run that differs.
 * @throws BudgetError `LEDGER_INVALID` for a ledger that does not parse.
 */
export async function ledgerProblems(project: LoadedProject, root: string): Promise<string[]> {
  const spendLedger = fileSpendLedger(join(root, SPEND_LEDGER_FILE));
  const ledger = await spendLedger.read();
  const byRun = new Map<string, SpendEntry[]>();
  for (const e of ledger) {
    const own = byRun.get(e.runId);
    if (own) own.push(e);
    else byRun.set(e.runId, [e]);
  }
  const timeZone = project.config.budget.time_zone;
  const cacheFile = join(root, CACHE_FILE);
  let raw: unknown = {};
  try {
    raw = JSON.parse(await readFile(cacheFile, "utf8"));
  } catch {
    // A missing or broken cache is only slower: every journal is read again.
  }
  const cached = CacheSchema.safeParse(raw);
  const cache = cached.success ? { ...cached.data } : {};
  const problems: string[] = [];
  for (const run of await diskRuns(project, root)) {
    if (run.active) continue;
    const journal = await readFile(join(run.dir, "journal", "events.jsonl"), "utf8").catch(() => undefined);
    if (journal === undefined) continue;
    const key = `${run.ticket}/${run.runId}`;
    const journalSha256 = createHash("sha256").update(journal).digest("hex");
    const hit = cache[key];
    const proved: RunProof =
      hit?.journalSha256 === journalSha256 ? hit : proofOf(journalEntries(run, journal), timeZone);
    cache[key] = { journalSha256, ...proved };
    const own = byRun.get(run.runId) ?? [];
    const elsewhere = own.filter((e) => e.ticket !== run.ticket || e.ticketVersion !== run.version);
    const recorded = proofOf(own, timeZone);
    if (elsewhere.length > 0)
      problems.push(
        `${key}: ${String(elsewhere.length)} ledger entr(ies) booked to another ticket or ticket version`,
      );
    else if (recorded.fingerprint !== proved.fingerprint)
      problems.push(
        `${key}: the journal has ${String(proved.calls)} model call(s), ${String(proved.tokens)} tokens, the ledger ${String(recorded.calls)} call(s), ${String(recorded.tokens)} tokens`,
      );
    else if (recorded.activeMs > proved.activeMs)
      problems.push(
        `${key}: the ledger holds ${String(recorded.activeMs)} ms of active time, the journal ${String(proved.activeMs)} ms`,
      );
    else if (recorded.activeMs < proved.activeMs) {
      const last = own.at(-1);
      await spendLedger.topUpActiveTime(
        {
          ts: last?.ts ?? new Date().toISOString(),
          project: run.project,
          ticket: run.ticket,
          ticketVersion: run.version,
          runId: run.runId,
          stage: "run",
        },
        proved.activeMs,
      );
    }
  }
  await writeCache(cacheFile, cache);
  return problems;
}

/**
 * Fails closed when the ledger cannot be trusted (REQ-FLOW-06/AC2): new work waits until it is rebuilt.
 *
 * @throws BudgetError `LEDGER_INVALID` or `LEDGER_MISMATCH`.
 */
export async function assertLedgerMatches(project: LoadedProject, root: string): Promise<void> {
  const problems = await ledgerProblems(project, root);
  if (problems.length > 0)
    throw new BudgetError(
      "LEDGER_MISMATCH",
      `The spend ledger does not match the run journals; rebuild it with qajitsu budget --rebuild.\n${problems
        .slice(0, 5)
        .map((p) => `  ${p}`)
        .join("\n")}`,
      { runs: problems.length },
    );
}

/**
 * Regenerates the ledger from the run journals (`qajitsu budget --rebuild`, REQ-FLOW-06/AC2): every run on disk gets
 * the entries its journal proves; entries of runs no longer on disk are kept, so cleaning runs never lowers a total.
 *
 * @param project - The project.
 * @param root - The project's runs root.
 * @returns The runs rebuilt, entries written and invalid lines dropped.
 * @throws BudgetError `LEDGER_RUN_ACTIVE` while a run is active: its calls would be lost.
 */
export async function rebuildLedger(
  project: LoadedProject,
  root: string,
): Promise<{ runs: number; entries: number; dropped: number }> {
  const runs = await diskRuns(project, root);
  const active = runs.find((r) => r.active);
  if (active)
    throw new BudgetError(
      "LEDGER_RUN_ACTIVE",
      `Run ${active.runId} of ${active.ticket} is active; rebuild the spend ledger when it has finished.`,
      { run: active.runId },
    );
  const proved: SpendEntry[] = [];
  // Only runs whose journal is still there are proved again; the others keep their ledger entries.
  const onDisk = new Set<string>();
  for (const run of runs) {
    const journal = await readFile(join(run.dir, "journal", "events.jsonl"), "utf8").catch(() => undefined);
    if (journal === undefined) continue;
    onDisk.add(run.runId);
    proved.push(...journalEntries(run, journal));
  }
  let entries = 0;
  const { dropped } = await fileSpendLedger(join(root, SPEND_LEDGER_FILE)).rebuild(async (valid) => {
    // A run that started again since the journals were read would lose its newer calls: checked under the lock.
    const resumed = (await diskRuns(project, root)).find((r) => r.active);
    if (resumed)
      throw new BudgetError(
        "LEDGER_RUN_ACTIVE",
        `Run ${resumed.runId} of ${resumed.ticket} is active; rebuild the spend ledger when it has finished.`,
        { run: resumed.runId },
      );
    const next = [...valid.filter((e) => !onDisk.has(e.runId)), ...proved].sort((a, b) =>
      a.ts.localeCompare(b.ts),
    );
    entries = next.length;
    return next;
  });
  // The journals were all read again: the cache starts over.
  await rm(join(root, CACHE_FILE), { force: true });
  return { runs: runs.length, entries, dropped };
}
