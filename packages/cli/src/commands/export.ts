import { copyFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ConfigError, QajitsuError, exitCodeFor } from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import type { RuntimePorts } from "../adapters.js";
import { openSession, type ModelPorts } from "../session.js";
import type { CommandIO } from "./fetch.js";
import { buildEvidenceZip } from "./publish.js";
import { computeVerdict, writeReports } from "./verdict.js";

/**
 * `qajitsu export <TICKET> [--run <id>] [--out <dir>]`: the pipeline artifacts of a run (REQ-CI-04/AC3):
 * report.html, junit.xml, matrix.md/csv and the secret-scanned evidence zip built from the manifest.
 * Reports are recomputed from the files on disk, so the export says the same as `run` and `publish`.
 *
 * @returns The run's exit code (0/1/2) so a pipeline step can fail on it, or 3 on errors.
 */
export async function runExport(
  rawKey: string,
  options: { readonly run?: string | undefined; readonly out?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts & ModelPorts,
): Promise<number> {
  const masker = createMasker();
  try {
    const session = await openSession(rawKey, options.run, io.cwd, ports, masker);
    if (session.ws.record.data["results"] === undefined)
      throw new ConfigError("RUN_NOT_EXECUTED", "This run has no results yet; run 'qajitsu run' first.", {});
    const verdict = await computeVerdict(session, ports.now);
    await writeReports(session, verdict);
    // REQ-PRJ-10/AC2: by default into the project's exports/, never the current folder.
    const out =
      options.out !== undefined
        ? resolve(io.cwd, options.out)
        : join(
            session.project.project?.paths.exports ?? session.ws.path("report"),
            session.ws.ticket,
            session.ws.runId,
          );
    await mkdir(out, { recursive: true });
    const bundle = await buildEvidenceZip(session, verdict);
    const files = ["report.html", "junit.xml", "matrix.md", "matrix.csv", "gates.json"];
    for (const f of files) await copyFile(session.ws.path("report", f), join(out, f));
    await copyFile(bundle.path, join(out, bundle.name));
    io.write(`${[...files, bundle.name].map((f) => join(out, f)).join("\n")}\n`);
    if (!verdict.ok) io.writeError(`Publish gates failed: ${verdict.failed.map((g) => g.gate).join(", ")}\n`);
    const code = exitCodeFor(verdict.cases.map((c) => c.status));
    return !verdict.ok && code === 0 ? 2 : code;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(
      masker.maskText(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`),
    );
    return 3;
  }
}
