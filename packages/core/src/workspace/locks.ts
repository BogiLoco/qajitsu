import { open, readFile, rm, stat } from "node:fs/promises";
import { ConfigError } from "../errors.js";

const isErrno = (error: unknown, code: string): boolean =>
  error instanceof Error && (error as NodeJS.ErrnoException).code === code;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Runs `fn` while holding an exclusive lock file (created with `O_EXCL`). Used for the read-modify-write
 * of `index.json`, so parallel runs of one ticket do not lose entries (REQ-WS-04/AC2). A lock older than
 * `staleMs` is considered abandoned by a crashed process and taken over.
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
        await rm(path, { force: true });
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

/**
 * Takes the lock of one run folder: two processes never write the same run, different runs of a ticket
 * may run in parallel (REQ-WS-04/AC2). A lock left by a dead process is taken over.
 *
 * @param lockFile - `<run>/run.lock`.
 * @param pid - Pid of this process.
 * @param alive - Liveness check (injected in tests).
 * @returns A function releasing the lock.
 * @throws {ConfigError} `RUN_LOCKED` when a live process holds the run.
 */
export async function acquireRunLock(
  lockFile: string,
  pid: number = process.pid,
  alive: (pid: number) => boolean = processAlive,
): Promise<() => Promise<void>> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const handle = await open(lockFile, "wx", 0o600);
      await handle.writeFile(`${String(pid)}\n`);
      await handle.close();
      return () => rm(lockFile, { force: true });
    } catch (error) {
      if (!isErrno(error, "EEXIST")) throw error;
      const holder = Number((await readFile(lockFile, "utf8").catch(() => "")).trim());
      if (Number.isInteger(holder) && holder > 0 && holder !== pid && alive(holder)) {
        throw new ConfigError("RUN_LOCKED", `This run is in use by process ${String(holder)}.`, {
          pid: holder,
        });
      }
      await rm(lockFile, { force: true });
    }
  }
  throw new ConfigError("RUN_LOCKED", "Could not lock the run.", {});
}
