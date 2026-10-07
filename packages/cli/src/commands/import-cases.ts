import { mkdir, writeFile } from "node:fs/promises";
import {
  ImportedCasesFileSchema,
  type EventLog,
  type ImportedCase,
  type ImportedCasesFile,
  type RunWorkspace,
  type TestCaseSource,
} from "@qajitsu/core";
import type { Masker } from "@qajitsu/steps";
import type { CommandIO } from "./fetch.js";

/**
 * Reads the manual test cases linked to the run's ticket from every configured source into `imported/cases.json`
 * (REQ-CTX-08). The text is masked before it is stored. A source that fails is reported in the terminal, the journal
 * and the file, and the run continues without it (AC4); a case id seen twice is kept once.
 *
 * @returns The written file content, or undefined when no source is configured.
 */
export async function importTestCases(options: {
  readonly ws: RunWorkspace;
  readonly sources: readonly TestCaseSource[];
  readonly events: EventLog;
  readonly masker: Masker;
  readonly io: CommandIO;
  readonly now: () => Date;
}): Promise<ImportedCasesFile | undefined> {
  const { ws, sources, events, masker, io } = options;
  if (sources.length === 0) return undefined;
  const system = { kind: "system", name: "orchestrator" } as const;
  const cases = new Map<string, ImportedCase>();
  const reports: ImportedCasesFile["sources"] = [];
  for (const source of sources) {
    try {
      const found = await source.findCases(ws.ticket);
      let added = 0;
      for (const c of found)
        if (!cases.has(c.id)) {
          cases.set(c.id, masker.maskJson(c) as ImportedCase);
          added += 1;
        }
      reports.push({ system: source.system, ok: true, cases: added });
      io.write(`Imported test cases: ${source.system} ${String(added)}\n`);
    } catch (error) {
      const reason = masker.maskText(error instanceof Error ? error.message : String(error)).slice(0, 1000);
      reports.push({ system: source.system, ok: false, cases: 0, error: reason });
      events.emit("fetch", system, "imported.unavailable", { system: source.system, reason });
      io.writeError(
        `Warning: test cases from ${source.system} are unavailable (${reason}); planning continues without them.\n`,
      );
    }
  }
  const file = ImportedCasesFileSchema.parse({
    ticket: ws.ticket,
    fetchedAt: options.now().toISOString(),
    sources: reports,
    cases: [...cases.values()],
  });
  await mkdir(ws.path("imported"), { recursive: true });
  await writeFile(ws.path("imported", "cases.json"), `${JSON.stringify(file, null, 2)}\n`);
  events.emit("fetch", system, "imported.cases", {
    cases: file.cases.length,
    sources: reports.map((r) => ({ system: r.system, ok: r.ok, cases: r.cases })),
  });
  return file;
}
