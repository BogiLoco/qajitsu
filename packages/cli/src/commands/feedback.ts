import { ConfigError, QajitsuError, TicketKeySchema } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** What a person found a FAILED case to be, after looking at it (REQ-PLAN-16/AC4). */
export const CASE_VERDICTS = ["product-bug", "test-bug", "environment", "data"] as const;

/** A person's finding about a run, recorded after it (REQ-PLAN-16/AC2+AC4). */
export interface RunFeedback {
  readonly cases: Readonly<
    Record<
      string,
      {
        readonly is: (typeof CASE_VERDICTS)[number];
        readonly by: string;
        readonly at: string;
        readonly note?: string;
      }
    >
  >;
  readonly escaped: readonly {
    readonly bug: string;
    readonly by: string;
    readonly at: string;
    readonly note?: string;
  }[];
}

/** The feedback recorded in a run, empty when there is none. */
export function feedbackOf(data: Readonly<Record<string, unknown>>): RunFeedback {
  const f = data["feedback"] as Partial<RunFeedback> | undefined;
  return { cases: f?.cases ?? {}, escaped: f?.escaped ?? [] };
}

/**
 * `qajitsu feedback <TICKET> [--run <id>] (--case <id> --is <kind> | --escaped <BUG>) [--note <text>]`: records what a
 * person found after a run (REQ-PLAN-16): what a FAILED case really was (a product bug, or a test, environment or data
 * problem, so false FAILED can be counted), or a defect found later on a ticket the run passed (an escaped defect).
 * Feedback never changes a status, the results or the certificate; it is kept in `run.json` and the journal.
 *
 * @returns 0 recorded, 3 errors.
 */
export async function runFeedback(
  rawKey: string,
  options: {
    readonly run?: string | undefined;
    readonly case?: string | undefined;
    readonly is?: string | undefined;
    readonly escaped?: string | undefined;
    readonly note?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  user: string,
): Promise<number> {
  const masker = createMasker();
  try {
    const caseFeedback = options.case !== undefined || options.is !== undefined;
    if (caseFeedback === (options.escaped !== undefined))
      throw new ConfigError(
        "FEEDBACK_KIND",
        "Give either --case <id> --is <product-bug|test-bug|environment|data> or --escaped <BUG-KEY>.",
        {},
      );
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const { ws, events } = session;
    const results = (ws.record.data["results"] ?? {}) as Record<string, string>;
    if (Object.keys(results).length === 0)
      throw new ConfigError(
        "RUN_NOT_EXECUTED",
        "This run has no results yet; feedback is about executed runs.",
        {},
      );
    const at = ports.now().toISOString();
    const note = options.note === undefined ? {} : { note: masker.maskText(options.note).slice(0, 1000) };
    const before = feedbackOf(ws.record.data);
    let next: RunFeedback;
    if (caseFeedback) {
      const is = CASE_VERDICTS.find((v) => v === options.is);
      if (options.case === undefined || is === undefined)
        throw new ConfigError(
          "FEEDBACK_KIND",
          "--case <id> needs --is product-bug, test-bug, environment or data.",
          {},
        );
      if (results[options.case] !== "FAILED")
        throw new ConfigError(
          "FEEDBACK_NOT_FAILED",
          `${options.case} is ${results[options.case] ?? "not a case of this run"}; --is is for FAILED cases.`,
          {},
        );
      next = { ...before, cases: { ...before.cases, [options.case]: { is, by: user, at, ...note } } };
      events.emit("feedback", { kind: "user", name: user }, "feedback.case", {
        caseId: options.case,
        is,
        ...note,
      });
      io.write(
        `Recorded ${options.case} of ${ws.ticket} (run ${ws.runId}) as ${is}; its status stays FAILED.\n`,
      );
    } else {
      const bug = TicketKeySchema.safeParse(options.escaped ?? "");
      if (!bug.success)
        throw new ConfigError("TICKET_KEY_INVALID", "--escaped takes a ticket key like SHOP-512.", {});
      next = { ...before, escaped: [...before.escaped, { bug: bug.data, by: user, at, ...note }] };
      events.emit("feedback", { kind: "user", name: user }, "feedback.escaped", { bug: bug.data, ...note });
      io.write(`Recorded ${bug.data} as a defect that escaped run ${ws.runId} of ${ws.ticket}.\n`);
    }
    await ws.update({ data: { ...ws.record.data, feedback: next } });
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
