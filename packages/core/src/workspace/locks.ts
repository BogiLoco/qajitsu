import { randomBytes } from "node:crypto";
import { link, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { ConfigError } from "../errors.js";

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const unique = (path: string): string => `${path}.${String(process.pid)}-${randomBytes(4).toString("hex")}`;

/**
 * Runs `fn` while holding an exclusive lock file (created with `O_EXCL`). Used for the read-modify-write
 * of `index.json`, so parallel runs of one ticket do not lose entries (REQ-WS-04/AC2). A lock older than
 * `staleMs` is considered abandoned by a crashed process; it is taken over by an atomic rename, so two
 * processes never both take it, and a fresh lock renamed by mistake is put back.
 *
 * @param path - Lock file path.
 * @param fn - Work done under the lock.
 * @throws {ConfigError} `LOCK_TIMEOUT` when the lock is not free within `timeoutMs`.
 */
export async function withFileLock<T>(
  path: string,
  fn: () => Promise<T>,
  options: { readonly timeoutMs?: number; readonly staleMs?: number } = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const staleMs = options.staleMs ?? 30_000;
  const start = Date.now();
  for (;;) {
    try {
      const handle = await open(path, "wx");
      await handle.close();
      break;
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const age = await stat(path).then(
        (s) => Date.now() - s.mtimeMs,
        () => 0,
      );
      if (age > staleMs) {
        const aside = unique(path);
        const moved = await rename(path, aside).then(
          () => true,
          () => false,
        );
        if (moved) {
          const movedAge = await stat(aside).then(
            (s) => Date.now() - s.mtimeMs,
            () => Number.POSITIVE_INFINITY,
          );
          // Someone else replaced the stale lock in between: give theirs back.
          if (movedAge <= staleMs) await link(aside, path).catch(() => undefined);
          await rm(aside, { force: true });
        }
        continue;
      }
      if (Date.now() - start > timeoutMs)
        throw new ConfigError("LOCK_TIMEOUT", `Could not lock ${path}.`, { path });
      await pause(15 + Math.floor(Math.random() * 20));
    }
  }
  try {
    return await fn();
  } finally {
    await rm(path, { force: true });
  }
}

/** Whether a process with this pid is alive on this machine. */
export const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isErrno(error, "EPERM");
  }
};

const readHolder = async (lockFile: string): Promise<number | undefined> => {
  const text = (await readFile(lockFile, "utf8").catch(() => "")).trim();
  const pid = Number(text);
  return /^\d+$/.test(text) && pid > 0 ? pid : undefined;
};

/**
 * Takes the lock of one run folder: two processes never write the same run, different runs of a ticket
 * may run in parallel (REQ-WS-04/AC2). The lock file appears atomically with the owner's pid inside
 * (`link` of a written temp file). A lock whose owner is dead is taken over; an unreadable lock counts
 * as held.
 *
 * @param lockFile - `<run>/run.lock`.
 * @param pid - Pid of this process.
 * @param alive - Liveness check (injected in tests).
 * @returns A function releasing the lock (only while it still holds this pid).
 * @throws {ConfigError} `RUN_LOCKED` when another live process, or an unknown one, holds the run.
 */
export async function acquireRunLock(
  lockFile: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = processAlive,
): Promise<() => Promise<void>> {
  const tmp = unique(lockFile);
  await writeFile(tmp, `${String(pid)}\n`, { mode: 0o600 });
  try {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await link(tmp, lockFile);
        return async () => {
          if ((await readHolder(lockFile)) === pid) await rm(lockFile, { force: true });
        };
      } catch (error) {
        if (!isErrno(error, "EEXIST")) throw error;
        const holder = await readHolder(lockFile);
        if (holder === undefined || holder === pid || alive(holder)) {
          throw new ConfigError(
            "RUN_LOCKED",
            holder === undefined
              ? `This run is locked (${lockFile}); remove the file if no process uses the run.`
              : `This run is in use by process ${String(holder)}.`,
            holder === undefined ? {} : { pid: holder },
          );
        }
        // The owner is dead: move its lock aside atomically; only one taker wins the rename.
        const aside = unique(lockFile);
        if (
          await rename(lockFile, aside).then(
            () => true,
            () => false,
          )
        ) {
          if ((await readHolder(aside)) !== holder) await link(aside, lockFile).catch(() => undefined);
          await rm(aside, { force: true });
        }
      }
    }
    throw new ConfigError("RUN_LOCKED", "Could not lock the run.", {});
  } finally {
    await rm(tmp, { force: true });
  }
}
