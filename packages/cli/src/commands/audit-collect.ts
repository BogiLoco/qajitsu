import { ConfigError, QajitsuError } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import { collectQueuedAudit } from "./checks.js";
import type { CommandIO } from "./fetch.js";
import { computeVerdict, writeReports } from "./verdict.js";

/** Options of `qajitsu audit collect`. */
export interface AuditCollectOptions {
  readonly run?: string | undefined;
  /** Waits until the batch is answered, asking every `interval` seconds, at most `timeout` seconds. */
  readonly wait?: boolean | undefined;
  readonly interval?: string | undefined;
  readonly timeout?: string | undefined;
}

const seconds = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new ConfigError(
      "OPTION_INVALID",
      `--${name} needs a whole number of seconds, not '${value.slice(0, 20)}'.`,
      {},
    );
  return n;
};

/**
 * Collects a queued audit and, once collected, recomputes the run's statuses and reports (REQ-VER-06/AC4).
 *
 * @param session - The run.
 * @param io - Where progress goes.
 * @param now - The command's clock.
 * @returns `pending` while the batch is not answered, `collected` once its record replaced the queued one, `none`
 *   when the run has no queued audit.
 */
export async function collectAndReport(
  session: RunSession,
  io: CommandIO,
  now: () => Date,
): Promise<"none" | "pending" | "collected"> {
  const collected = await collectQueuedAudit(session, now);
  if (collected === undefined) return "none";
  if (collected.status === "pending") {
    io.write(
      `Audit still in the provider's batch${collected.counts ? ` (${String(collected.counts.completed)} of ${String(collected.counts.total)} answered)` : ""}.\n`,
    );
    return "pending";
  }
  const { record } = collected;
  io.write(
    record.status === "done"
      ? `Audit collected: ${String(record.findings.filter((f) => f.weak).length)} of ${String(record.findings.length)} PASSED case(s) flagged.\n`
      : `Audit failed (${record.mode}): ${record.status === "failed" ? record.error : ""}\n`,
  );
  // The statuses and reports follow the new record, computed by code as at the end of a run.
  const verdict = await computeVerdict(session, now);
  await writeReports(session, verdict);
  io.write(`${verdict.matrixMd}\n`);
  return "collected";
}

/**
 * `qajitsu audit collect <TICKET>`: collects the audit a run sent to the provider's batch API (REQ-VER-06/AC4).
 *
 * @returns 0 collected (or nothing queued), 2 still pending, 3 errors.
 */
export async function runAuditCollect(
  rawKey: string,
  options: AuditCollectOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts & { readonly sleep?: (ms: number) => Promise<void> },
): Promise<number> {
  const masker = createMasker();
  try {
    const interval = seconds(options.interval, 60, "interval");
    const timeout = seconds(options.timeout, 24 * 3600, "timeout");
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const sleep =
      ports.sleep ??
      ((ms: number) =>
        new Promise<void>((done) => {
          setTimeout(done, ms);
        }));
    const started = ports.now().getTime();
    for (;;) {
      const outcome = await collectAndReport(session, io, ports.now);
      if (outcome === "none") {
        io.write(`Run ${session.ws.runId} of ${session.ws.ticket} has no queued audit.\n`);
        return 0;
      }
      if (outcome === "collected") return 0;
      if (options.wait !== true || ports.now().getTime() - started + interval * 1000 > timeout * 1000) {
        io.write(
          `The PASSED cases stay NEEDS_REVIEW until it is answered; run qajitsu audit collect ${session.ws.ticket} --run ${session.ws.runId}${options.wait === true ? "" : " --wait"} again.\n`,
        );
        return 2;
      }
      await sleep(interval * 1000);
    }
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
