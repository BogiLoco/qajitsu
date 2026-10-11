import { mkdir, open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { QajitsuError } from "@qajitsu/core";

/** A held setup lock. */
export interface SetupLock {
  release(): Promise<void>;
}

/** Whether a process is alive (`kill(pid, 0)` only checks). */
export type IsAlive = (pid: number) => boolean;

const defaultIsAlive: IsAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: it exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Takes the toolchain lock so two setups cannot run at once (REQ-GEN-06/AC6). A lock left by a process that is gone
 * is taken over.
 *
 * @param root - The toolchain folder.
 * @param pid - This process.
 * @throws {QajitsuError} `TOOLCHAIN_LOCKED` when another setup is running.
 */
export async function acquireSetupLock(
  root: string,
  pid: number = process.pid,
  isAlive: IsAlive = defaultIsAlive,
): Promise<SetupLock> {
  await mkdir(root, { recursive: true });
  const file = join(root, ".setup.lock");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await open(file, "wx", 0o644);
      await handle.writeFile(`${String(pid)}\n`);
      await handle.close();
      return {
        release: async () => {
          const owner = await readFile(file, "utf8").catch(() => "");
          if (Number(owner.trim()) === pid) await rm(file, { force: true });
        },
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const owner = Number((await readFile(file, "utf8").catch(() => "")).trim());
      if (Number.isInteger(owner) && owner > 0 && isAlive(owner))
        throw new QajitsuError(
          "TOOLCHAIN_LOCKED",
          `Another qj setup is running (process ${String(owner)}); wait for it to finish.`,
          { pid: owner },
        );
      await rm(file, { force: true });
    }
  }
  throw new QajitsuError("TOOLCHAIN_LOCKED", "Could not take the toolchain lock.", {});
}
