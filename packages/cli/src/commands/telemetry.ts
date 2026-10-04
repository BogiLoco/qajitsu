import { readFile } from "node:fs/promises";
import { QajitsuError, buildOtlp, parseEventLines } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts, type RunSession } from "../session.js";
import type { CommandIO } from "./fetch.js";

/** Result of one telemetry export. */
export interface TelemetryExport {
  readonly spans: number;
  readonly logs: number;
  readonly metrics: number;
}

/**
 * Exports the journal events not exported yet as OTLP traces, logs and metrics (REQ-OBS-03). The count
 * of exported lines is kept in `run.json`, so every command sends only what is new. Telemetry never
 * changes a result: failures are returned to the caller as a message, not thrown.
 *
 * @returns What was sent, undefined when telemetry is not configured.
 * @throws Never for collector errors; they come back as `error`.
 */
export async function exportRunTelemetry(
  session: RunSession,
  fetch: typeof globalThis.fetch,
  version = "0.0.0",
): Promise<(TelemetryExport & { readonly error?: string }) | undefined> {
  const otlp = session.project.config.telemetry?.otlp;
  if (!otlp) return undefined;
  const { ws } = session;
  const text = await readFile(ws.path("journal", "events.jsonl"), "utf8").catch(() => "");
  const { events } = parseEventLines(text);
  const state = (ws.record.data["telemetry"] ?? {}) as { exportedEvents?: number };
  const fromIndex = state.exportedEvents ?? 0;
  if (events.length <= fromIndex) return { spans: 0, logs: 0, metrics: 0 };
  const payload = buildOtlp(events, {
    serviceName: otlp.service_name,
    serviceVersion: version,
    fromIndex,
    includeDetails: otlp.include_details,
  });
  // Like the Jira publish gate: nothing goes out that still contains a known secret.
  if (session.masker.containsSecret(JSON.stringify(payload)))
    return { ...payload.counts, error: "the export contains a secret value; nothing was sent" };
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [name, value] of Object.entries(otlp.headers))
      headers[name] = value.startsWith("secret://") ? await session.resolveSecret(value) : value;
    const base = otlp.endpoint.replace(/\/+$/, "");
    for (const [path, body] of [
      ["/v1/traces", payload.traces],
      ["/v1/logs", payload.logs],
      ["/v1/metrics", payload.metrics],
    ] as const) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`${path} answered HTTP ${String(response.status)}`);
    }
    await ws.update({ data: { ...ws.record.data, telemetry: { exportedEvents: events.length } } });
    return payload.counts;
  } catch (error) {
    return {
      ...payload.counts,
      error: session.masker.maskText(error instanceof Error ? error.message : String(error)),
    };
  }
}

/** `qajitsu telemetry export <TICKET> [--run <id>]`: sends what is not exported yet (backfill, retries). */
export async function runTelemetryExport(
  rawKey: string,
  options: { readonly run?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    const result = await exportRunTelemetry(session, ports.fetch);
    if (!result) {
      io.writeError("Telemetry is not configured (telemetry.otlp in .qa/qa.project.yaml).\n");
      return 3;
    }
    if (result.error !== undefined) {
      io.writeError(`Telemetry export failed: ${result.error}\n`);
      return 3;
    }
    io.write(
      `Exported ${String(result.spans)} span(s), ${String(result.logs)} log record(s), ${String(result.metrics)} metric(s).\n`,
    );
    return 0;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
