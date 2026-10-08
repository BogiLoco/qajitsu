import { readFile } from "node:fs/promises";
import { QajitsuError } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts } from "../session.js";
import { annotatedFirst } from "./annotated.js";
import type { CommandIO } from "./fetch.js";
import { computeVerdict } from "./verdict.js";

/** Options of `qajitsu evidence`. */
export interface EvidenceOptions {
  readonly run?: string | undefined;
  readonly failed?: boolean | undefined;
  readonly case?: string | undefined;
  /** Open the trace of a case in Playwright Trace Viewer (REQ-PUB-06/AC2). */
  readonly trace?: string | undefined;
  /** Print only; do not open anything (CI). */
  readonly open?: boolean | undefined;
}

/** Opens files with the system (report in the browser, videos in the player, traces in the viewer). */
export interface OpenPorts {
  readonly openFile?: (path: string) => Promise<void>;
  readonly openTrace?: (path: string) => Promise<void>;
}

/**
 * `qajitsu evidence <TICKET>`: shows statuses, failed assertions, evidence files and the masked cURL of
 * every recorded call, so a failure can be reproduced locally (REQ-PUB-01/AC4).
 *
 * @returns 0, or 3 on errors.
 */
export async function runEvidence(
  rawKey: string,
  options: EvidenceOptions,
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
  open: OpenPorts = {},
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const v = await computeVerdict(session, ports.now);
    const cases = v.cases.filter(
      (c) =>
        (options.case === undefined || c.caseId === options.case) &&
        (!options.failed || ["FAILED", "FLAKY", "BLOCKED", "NEEDS_REVIEW"].includes(c.status)),
    );
    for (const c of cases) {
      io.write(`${c.caseId} ${c.status}${c.error ? ` (${c.error})` : ""}\n`);
      for (const f of c.failures)
        io.write(
          `  ✘ ${f.stepId} ${f.field}: expected ${JSON.stringify(f.expected)}, actual ${JSON.stringify(f.actual)}\n`,
        );
      // REQ-EVD-08/AC5: annotated screenshots first, with what each numbered box marks.
      for (const e of annotatedFirst(c.evidence, (x) => x.path)) {
        if (e.path.endsWith("-annotations.json")) {
          const marks = (
            JSON.parse(await readFile(session.ws.path("evidence", e.path), "utf8").catch(() => "{}")) as {
              marks?: { n: number; field: string; expected?: unknown; actual?: unknown; note?: string }[];
            }
          ).marks;
          for (const m of marks ?? [])
            io.write(
              `  [${String(m.n)}] ${e.stepId ?? ""} ${m.field}${m.note ? `: ${m.note}` : ""}${m.expected !== undefined ? ` (expected ${JSON.stringify(m.expected)}, actual ${JSON.stringify(m.actual)})` : ""}\n`,
            );
          continue;
        }
        io.write(
          `  ${e.stepId ?? ""} ${session.ws.path("evidence", e.path)} (sha256 ${e.sha256.slice(0, 12)})\n`,
        );
        try {
          const call = JSON.parse(await readFile(session.ws.path("evidence", e.path), "utf8")) as {
            curl?: string;
          };
          if (call.curl)
            io.write(
              `${call.curl
                .split("\n")
                .map((l) => `    ${l}`)
                .join("\n")}\n`,
            );
        } catch {
          // Not a recorded API call (screenshot, video, log).
        }
      }
    }
    if (cases.length === 0) io.write("No matching cases.\n");
    if (options.open !== false) {
      const { ws } = session;
      if (options.trace !== undefined) {
        const trace = v.cases
          .find((c) => c.caseId === options.trace)
          ?.evidence.find((e) => e.kind === "trace");
        if (!trace)
          throw new QajitsuError(
            "TRACE_NOT_FOUND",
            `No trace for ${options.trace}; traces are kept for failed attempts.`,
            {},
          );
        await open.openTrace?.(ws.path("evidence", trace.path));
      } else if (options.failed) {
        // REQ-PUB-06/AC2: failure videos open in the system player; REQ-EVD-08: annotated screenshots too.
        for (const c of cases)
          for (const e of c.evidence.filter((x) => x.kind === "video" || x.path.endsWith("-annotated.png")))
            await open.openFile?.(ws.path("evidence", e.path));
      } else {
        // REQ-PUB-06/AC1: the report of the run.
        await open.openFile?.(ws.path("report", "report.html"));
      }
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
