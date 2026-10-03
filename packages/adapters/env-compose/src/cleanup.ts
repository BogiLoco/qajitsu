import { execCommand, type CommandExec } from "./build.js";

const RUN_ID = /^\d{8}-\d{4}-[a-z0-9]{4}$/;

/** What {@link removeRunResources} removed. */
export interface RemovedResources {
  readonly containers: number;
  readonly volumes: number;
  readonly networks: number;
}

const ids = (stdout: string): string[] =>
  stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z0-9_.-]+$/.test(l));

/**
 * Removes the containers, volumes and networks of one run, found only by the `qajitsu.run` and
 * `qajitsu.managed` labels (REQ-WS-03/AC3, AC4): resources without QAJitsu labels are never touched.
 * Docker not being installed counts as nothing to remove.
 *
 * @param runId - Run id (validated, so it cannot widen the label filter).
 * @param exec - Command runner.
 * @returns Counts of removed resources.
 */
export async function removeRunResources(
  runId: string,
  exec: CommandExec = execCommand,
): Promise<RemovedResources> {
  if (!RUN_ID.test(runId)) return { containers: 0, volumes: 0, networks: 0 };
  const filters = ["--filter", `label=qajitsu.run=${runId}`, "--filter", "label=qajitsu.managed=true"];
  const list = async (args: string[]): Promise<string[]> => {
    try {
      return ids((await exec("docker", [...args, ...filters, "--quiet"], { timeoutMs: 60_000 })).stdout);
    } catch {
      return [];
    }
  };
  const remove = async (args: string[], found: string[]): Promise<number> => {
    if (found.length === 0) return 0;
    await exec("docker", [...args, ...found], { timeoutMs: 180_000 }).catch(() => undefined);
    return found.length;
  };
  const containers = await remove(["rm", "--force", "--volumes"], await list(["ps", "--all"]));
  const volumes = await remove(["volume", "rm", "--force"], await list(["volume", "ls"]));
  const networks = await remove(["network", "rm"], await list(["network", "ls"]));
  return { containers, volumes, networks };
}
