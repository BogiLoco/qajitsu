import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { BudgetError } from "../errors.js";
import { withFileLock } from "../workspace/locks.js";
import { SpendEntrySchema, type SpendEntry } from "./budget.js";

/** The project's spend ledger (REQ-FLOW-06/AC2): appended to and read under one lock by every run. */
export interface SpendLedger {
  /** Adds entries; parallel runs never lose one (AC5). */
  append(...entries: readonly SpendEntry[]): Promise<void>;
  /**
   * Every entry, checked with {@link SpendEntrySchema}.
   *
   * @throws {BudgetError} `LEDGER_INVALID` for a line that is not a valid entry: work that relies on the ledger stops
   *   until it is rebuilt from the run journals (fail closed).
   */
  read(): Promise<SpendEntry[]>;
  /**
   * Brings a run's active time in the ledger up to `runActiveMs` (REQ-FLOW-06/AC2): adds one runtime entry with what
   * the ledger does not hold yet for that run, under the same lock, so a command's time is never counted twice.
   *
   * @param entry - The runtime entry without its active time.
   * @param runActiveMs - The run's whole active time so far, from its journal.
   * @returns The milliseconds added (0 when the ledger already held them).
   */
  topUpActiveTime(
    entry: Omit<Extract<SpendEntry, { kind: "runtime" }>, "kind" | "activeMs">,
    runActiveMs: number,
  ): Promise<number>;
  /**
   * Replaces the ledger under its lock (`qajitsu budget --rebuild`): `next` gets every line that is still a valid
   * entry, invalid lines are dropped, and the result is written to a new file that replaces the old one at once.
   *
   * @param next - The new entries from the valid old ones.
   * @returns How many invalid lines were dropped.
   */
  rebuild(
    next: (valid: readonly SpendEntry[]) => readonly SpendEntry[] | Promise<readonly SpendEntry[]>,
  ): Promise<{ dropped: number }>;
}

/**
 * The ledger in a JSON-lines file (`<project runs>/budget/spend.jsonl`).
 *
 * @param file - The file.
 * @param options - How long to wait for the lock.
 */
export function fileSpendLedger(
  file: string,
  options: { readonly lockTimeoutMs?: number } = {},
): SpendLedger {
  const lock = `${file}.lock`;
  const locked = async <T>(fn: () => Promise<T>): Promise<T> => {
    await mkdir(dirname(file), { recursive: true });
    return withFileLock(
      lock,
      fn,
      options.lockTimeoutMs === undefined ? {} : { timeoutMs: options.lockTimeoutMs },
    );
  };
  const parse = (text: string): SpendEntry[] =>
    text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line, i) => {
        let raw: unknown;
        try {
          raw = JSON.parse(line);
        } catch {
          raw = undefined;
        }
        const entry = SpendEntrySchema.safeParse(raw);
        if (!entry.success)
          throw new BudgetError(
            "LEDGER_INVALID",
            `Line ${String(i + 1)} of the spend ledger ${file} is not a valid entry; rebuild it with qajitsu budget --rebuild.`,
            { file, line: i + 1 },
          );
        return entry.data;
      });
  const readAll = async (): Promise<SpendEntry[]> => {
    const text = await readFile(file, "utf8").catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
      throw error;
    });
    return parse(text);
  };
  return {
    append: (...entries) =>
      locked(async () => {
        const valid = entries.map((e) => SpendEntrySchema.parse(e));
        if (valid.length > 0) await appendFile(file, valid.map((e) => `${JSON.stringify(e)}\n`).join(""));
      }),
    read: () => locked(readAll),
    rebuild: (next) =>
      locked(async () => {
        const lines = (
          await readFile(file, "utf8").catch((error: unknown) => {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
            throw error;
          })
        )
          .split("\n")
          .filter((line) => line.trim() !== "");
        const valid = lines.flatMap((line) => {
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            return [];
          }
          const entry = SpendEntrySchema.safeParse(raw);
          return entry.success ? [entry.data] : [];
        });
        const out = (await next(valid)).map((e) => SpendEntrySchema.parse(e));
        // A new file of its own (never an existing path or a planted link), renamed over the ledger at once.
        const temp = `${file}.${String(process.pid)}-${randomBytes(6).toString("hex")}.tmp`;
        try {
          await writeFile(temp, out.map((e) => `${JSON.stringify(e)}\n`).join(""), {
            flag: "wx",
            mode: 0o600,
          });
          await rename(temp, file);
        } finally {
          await rm(temp, { force: true });
        }
        return { dropped: lines.length - valid.length };
      }),
    topUpActiveTime: (entry, runActiveMs) =>
      locked(async () => {
        const counted = (await readAll()).reduce(
          (n, e) => n + (e.kind === "runtime" && e.runId === entry.runId ? e.activeMs : 0),
          0,
        );
        const added = Math.round(runActiveMs) - counted;
        if (added <= 0) return 0;
        const line = SpendEntrySchema.parse({ ...entry, kind: "runtime", activeMs: added });
        await appendFile(file, `${JSON.stringify(line)}\n`);
        return added;
      }),
  };
}
