import { readFile } from "node:fs/promises";
import { QajitsuError, parseEventLines, processAlive, readHolder, type RunEvent } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** Options of `qajitsu logs`. */
export interface LogsOptions {
  readonly run?: string | undefined;
  readonly follow?: boolean | undefined;
  readonly stage?: string | undefined;
  readonly agent?: string | undefined;
  readonly case?: string | undefined;
}

/** Ports for `--follow`: waiting between polls, injectable for tests. */
export interface FollowPorts {
  readonly sleep?: (ms: number) => Promise<void>;
  /** Upper bound of polls, so tests and broken runs cannot follow forever. */
  readonly maxPolls?: number;
}

const matches = (e: RunEvent, o: LogsOptions): boolean => {
  if (o.stage !== undefined && e.stage !== o.stage) return false;
  if (o.agent !== undefined && !(e.actor.kind === "agent" && e.actor.name === o.agent)) return false;
  if (o.case !== undefined) {
    const d = e.details as Record<string, unknown> | undefined;
    if (d?.["caseId"] !== o.case) return false;
  }
  return true;
};

/**
 * Formats one event as a log line: time, stage, actor, event and a short masked summary.
 *
 * @param e - Event.
 * @param mask - Masker for the details.
 */
/** A context snapshot in one line (REQ-CTX-14/AC4): fragments, budget, reductions by kind and the catalogue. */
const contextLine = (d: Record<string, unknown>): string => {
  const fragments = Array.isArray(d["fragments"]) ? d["fragments"].length : 0;
  const reductions = Array.isArray(d["reductions"]) ? (d["reductions"] as { action?: string }[]) : [];
  const byAction = new Map<string, number>();
  for (const r of reductions) byAction.set(r.action ?? "?", (byAction.get(r.action ?? "?") ?? 0) + 1);
  const budget = d["budget"] as { tokens?: number; used?: number; counting?: string } | undefined;
  const catalogue = Array.isArray(d["catalogue"]) ? d["catalogue"].length : 0;
  return [
    ` ${String(fragments)} fragment(s)`,
    budget
      ? `${String(budget.used ?? 0)}/${String(budget.tokens ?? 0)} tokens (${budget.counting ?? "estimate"})`
      : "no budget",
    reductions.length > 0
      ? `${String(reductions.length)} reduction(s): ${[...byAction].map(([a, n]) => `${a} ${String(n)}`).join(", ")}`
      : "no reductions",
    `${String(catalogue)} behind handles`,
    `snapshot ${typeof d["sha256"] === "string" ? d["sha256"].slice(0, 12) : "?"}`,
  ].join(" · ");
};

export function formatEvent(e: RunEvent, mask: (t: string) => string): string {
  const details =
    e.event === "context.snapshot" && e.details !== null && typeof e.details === "object"
      ? contextLine(e.details as Record<string, unknown>)
      : e.details === undefined
        ? ""
        : ` ${mask(JSON.stringify(e.details)).slice(0, 300)}`;
  return `${e.ts.slice(11, 19)} ${e.stage.padEnd(8)} ${`${e.actor.kind}:${e.actor.name}`.padEnd(20)} ${e.event}${details}`;
}

/**
 * `qajitsu logs <TICKET>`: prints the run's structured event log, filtered by stage, agent or case;
 * `--follow` keeps printing new events until the run is no longer running (REQ-OBS-02/AC1).
 *
 * @returns 0, or 3 on errors.
 */
export async function runLogs(
  rawKey: string,
  options: LogsOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  follow: FollowPorts = {},
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const file = session.ws.path("journal", "events.jsonl");
    const sleep = follow.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    let printed = 0;
    for (let poll = 0; ; poll += 1) {
      const { events, invalidLines } = parseEventLines(await readFile(file, "utf8").catch(() => ""));
      for (const e of events.slice(printed))
        if (matches(e, options)) io.write(`${formatEvent(e, (t) => masker.maskText(t))}\n`);
      printed = events.length;
      if (poll === 0 && invalidLines.length > 0)
        io.writeError(`${String(invalidLines.length)} unreadable line(s) in events.jsonl\n`);
      if (!options.follow) break;
      const status = JSON.parse(await readFile(session.ws.path("run.json"), "utf8")) as { status?: string };
      // REQ-OBS-02/AC3: also while another live process holds the run (an exploratory session, env up).
      const holder = await readHolder(session.ws.path("run.lock"));
      const held = holder !== undefined && holder !== process.pid && processAlive(holder);
      if ((status.status !== "running" && !held) || poll + 1 >= (follow.maxPolls ?? Number.POSITIVE_INFINITY))
        break;
      await sleep(500);
    }
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
