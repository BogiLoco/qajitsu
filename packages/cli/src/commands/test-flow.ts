import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts } from "../session.js";
import { runFetch, type CommandIO, type FetchOptions } from "./fetch.js";
import { runPlan, type ReviewPorts } from "./plan.js";
import { runPublish } from "./publish.js";
import { runRun, type RunOptions, type RunPorts } from "./run.js";

/** Options of `qajitsu test`: those of `fetch` and `run`, plus `--dry-run`. */
export interface TestOptions extends FetchOptions, Omit<RunOptions, "run"> {
  /** Stop after the run: results stay local, nothing is published. */
  readonly dryRun?: boolean | undefined;
}

/** Ports of `qajitsu test`: every stage's ports. */
export interface TestPorts {
  readonly review: ReviewPorts;
  /** Compresses a video before publishing (REQ-EVD-06/AC2). */
  readonly compressVideo?: ((input: string, output: string) => Promise<boolean>) | undefined;
}

/**
 * `qajitsu test <TICKET>`: the whole flow in one command (REQ-GEN-05/AC2): `fetch`, `plan` with the
 * interactive review, `run` and `publish` with its preview. It stops at the two human decisions it
 * cannot take: a plan that is not approved stops before anything runs, and a declined preview publishes
 * nothing. Every stage keeps its own rules; this command only chains them on one run.
 *
 * @returns The exit code of `run` (0 all passed, 1 any failed, 2 otherwise), 2 when the plan was not
 *   approved, or 3 when a stage failed (REQ-CI-04).
 */
export async function runTest(
  rawKey: string,
  options: TestOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & RunPorts,
  flow: TestPorts,
): Promise<number> {
  const fetched = await runFetch(
    rawKey,
    {
      ...(options.pr ? { pr: options.pr } : {}),
      ...(options.mr ? { mr: options.mr } : {}),
      ...(options.ref ? { ref: options.ref } : {}),
    },
    io,
    ports,
  );
  if (fetched !== 0) return fetched;
  // The run just created; every later stage works on it, never on a newer run of the same ticket.
  const runId = (await openSession(rawKey, undefined, io.cwd, ports, createMasker())).ws.runId;
  const planned = await runPlan(rawKey, { run: runId }, io, ports, flow.review);
  if (planned !== 0) return planned;
  const approved = (await openSession(rawKey, runId, io.cwd, ports, createMasker())).ws.record.data[
    "approval"
  ];
  if (approved === undefined) {
    io.write(
      `The plan is not approved; nothing was run. Continue with 'qajitsu approve ${rawKey} --run ${runId}' and 'qajitsu resume ${rawKey} --run ${runId}'.\n`,
    );
    return 2;
  }
  const ran = await runRun(
    rawKey,
    { run: runId, env: options.env, build: options.build, keep: options.keep, set: options.set },
    io,
    ports,
  );
  if (ran === 3) return ran;
  if (options.dryRun) {
    io.write(
      `Dry run: results not published; publish later with 'qajitsu publish ${rawKey} --run ${runId}'.\n`,
    );
    return ran;
  }
  const published = await runPublish(rawKey, { run: runId }, io, ports, flow.review.user, flow.compressVideo);
  return published === 3 ? 3 : ran;
}
