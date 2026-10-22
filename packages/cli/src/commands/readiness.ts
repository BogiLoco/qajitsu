import { readFile, readdir, writeFile } from "node:fs/promises";
import type { Analysis, Publisher } from "@qajitsu/core";
import { checkReadiness, formatReadiness, type ReadinessResult } from "@qajitsu/verifier";
import type { RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** The paths a change touches: from the diffs in `repos/` (full code access) or the metadata files (REQ-CTX-10). */
async function changedPaths(session: Pick<RunSession, "ws">): Promise<string[]> {
  const dir = session.ws.path("repos");
  const paths = new Set<string>();
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    if (name.endsWith(".diff"))
      for (const m of (await readFile(session.ws.path("repos", name), "utf8")).matchAll(
        /^diff --git a\/\S+ b\/(\S+)$/gm,
      ))
        if (m[1]) paths.add(m[1]);
    if (name.endsWith(".meta.json"))
      try {
        const meta = JSON.parse(await readFile(session.ws.path("repos", name), "utf8")) as {
          files?: unknown;
        };
        for (const f of Array.isArray(meta.files) ? meta.files : []) if (typeof f === "string") paths.add(f);
      } catch {
        // An unreadable metadata file adds no paths; the gate still runs on what it has.
      }
  }
  return [...paths].sort();
}

/**
 * How many changes the discovery found (`repos/changes.json`): also with metadata access, where nothing is checked
 * out and `run.json` names no repository.
 */
async function changesFound(session: Pick<RunSession, "ws">): Promise<number> {
  try {
    const found = JSON.parse(await readFile(session.ws.path("repos", "changes.json"), "utf8")) as {
      changes?: unknown[];
    };
    if (Array.isArray(found.changes)) return found.changes.length;
  } catch {
    // No discovery record: fall back to the checked-out repositories.
  }
  return Object.keys(session.ws.record.repos).length;
}

/**
 * Runs the ticket readiness gate before the first plan (REQ-PLAN-13): records the result in `run.json`,
 * `readiness.json` and the journal, prints it and posts it to the ticket as configured.
 *
 * @param session - The run.
 * @param io - Terminal.
 * @param input - The analysis, whether an environment was given, the publisher and the clock.
 */
export async function runReadinessGate(
  session: RunSession,
  io: CommandIO,
  input: {
    readonly analysis: Analysis;
    readonly env?: string | undefined;
    readonly publisher: Publisher;
    readonly now: () => Date;
  },
): Promise<ReadinessResult> {
  const { ws, project, events, masker } = session;
  const ticket = JSON.parse(await readFile(ws.path("ticket", "ticket.json"), "utf8")) as {
    summary?: string;
    description?: string;
    acceptanceCriteria?: string[];
    labels?: string[];
    components?: string[];
  };
  const result = checkReadiness({
    ticket: {
      summary: ticket.summary ?? "",
      description: ticket.description ?? "",
      acceptanceCriteria: ticket.acceptanceCriteria ?? [],
      labels: ticket.labels ?? [],
      components: ticket.components ?? [],
    },
    codeAccess: project.config.code.access,
    changes: await changesFound(session),
    changedFiles: await changedPaths(session),
    environmentKnown: input.env !== undefined || project.config.environments.default !== undefined,
    analysis: input.analysis,
    rules: project.config.readiness.risk_rules,
  });
  const at = input.now().toISOString();
  await writeFile(ws.path("readiness.json"), `${JSON.stringify({ schema: 1, at, ...result }, null, 2)}\n`);
  await ws.update({
    data: { ...ws.record.data, readiness: { result: result.result, risk: result.risk, at } },
  });
  events.emit("plan", { kind: "system", name: "orchestrator" }, "readiness.result", {
    result: result.result,
    risk: result.risk,
    gaps: result.gaps.length,
  });
  const lines = formatReadiness(result);
  io.write(`${lines.join("\n")}\n`);
  // REQ-PLAN-13/AC4: the result goes to the ticket as a structured comment; a failed comment never changes it.
  const mode = project.config.readiness.comment;
  if (mode === "always" || (mode === "not_ready" && result.result !== "READY")) {
    const masked = lines.map((l) => masker.maskText(l));
    try {
      await input.publisher.publish({
        ticket: ws.ticket,
        runId: ws.runId,
        name: "readiness",
        comment: {
          adf: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [
                  { type: "text", text: `QAJitsu readiness of ${ws.ticket}`, marks: [{ type: "strong" }] },
                ],
              },
              ...masked.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
            ],
          },
          wiki: `*QAJitsu readiness of ${ws.ticket}*\n{noformat}\n${masked.join("\n").replace(/\{noformat\}/gi, "{ noformat }")}\n{noformat}`,
        },
        attachments: [],
      });
    } catch (error) {
      io.writeError(
        `Warning: the readiness comment was not posted to ${ws.ticket}: ${masker.maskText(error instanceof Error ? error.message : String(error))}\n`,
      );
    }
  }
  return result;
}

/** Records that a person planned a ticket the gate did not find READY (REQ-PLAN-13/AC3). */
export async function recordReadinessOverride(
  session: Pick<RunSession, "ws" | "events" | "masker">,
  input: {
    readonly user: string;
    readonly reason: string;
    readonly result: string;
    readonly now: () => Date;
  },
): Promise<void> {
  const reason = session.masker.maskText(input.reason).slice(0, 1000);
  const override = { by: input.user, reason, result: input.result, at: input.now().toISOString() };
  await session.ws.update({ data: { ...session.ws.record.data, readinessOverride: override } });
  session.events.emit("plan", { kind: "user", name: input.user }, "readiness.overridden", override);
}
