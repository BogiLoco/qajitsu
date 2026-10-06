import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AUDIT_DIR,
  QajitsuError,
  RunIdSchema,
  TicketKeySchema,
  ConfigError,
  readRunIndex,
  resolveWorkspaceRoot,
  verifyEventChain,
} from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import type { CommandIO } from "./fetch.js";

/**
 * `qajitsu audit verify <TICKET> [--run <id> | --all]` or `qajitsu audit verify --file <path>`: checks the
 * hash chain of run journals, also archived ones (REQ-OBS-05/AC1).
 *
 * @returns 0 when every journal is intact, 1 when a chain is broken, 3 on errors.
 */
export async function runAuditVerify(
  rawKey: string | undefined,
  options: {
    readonly run?: string | undefined;
    readonly all?: boolean | undefined;
    readonly file?: string | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const files: { name: string; path: string }[] = [];
    if (options.file !== undefined) {
      files.push({ name: options.file, path: resolve(io.cwd, options.file) });
    } else {
      const key = TicketKeySchema.safeParse(rawKey ?? "");
      if (!key.success)
        throw new ConfigError("TICKET_KEY_INVALID", "Pass a ticket key or --file <journal>.", {});
      const project = await loadProject(io.cwd, ports.project);
      const root = resolveWorkspaceRoot({
        configured: project.config.workspace.root,
        home: ports.home,
        cwd: project.qaDir,
      });
      const index = await readRunIndex(root, key.data);
      if (options.run !== undefined && !RunIdSchema.safeParse(options.run).success)
        throw new ConfigError("RUN_ID_INVALID", "Expected a run id like 20261003-1046-k7f3.", {});
      const ids = options.all === true ? index.runs.map((r) => r.runId) : [options.run ?? index.latest ?? ""];
      if (ids[0] === "" || ids.length === 0)
        throw new ConfigError("RUN_NOT_FOUND", `No run for ${key.data}.`, {});
      // --all also covers journals of deleted runs kept in the audit archive.
      if (options.all === true)
        for (const f of await readdir(join(root, AUDIT_DIR, key.data)).catch(() => [])) {
          const id = f.replace(/\.events\.jsonl$/, "");
          if (f.endsWith(".events.jsonl") && !ids.includes(id)) ids.push(id);
        }
      for (const id of ids) {
        const live = join(root, key.data, id, "journal", "events.jsonl");
        const archived = join(root, AUDIT_DIR, key.data, `${id}.events.jsonl`);
        const exists = await readFile(live).then(
          () => true,
          () => false,
        );
        files.push({ name: `${key.data}/${id}`, path: exists ? live : archived });
      }
    }
    let broken = 0;
    for (const f of files) {
      const text = await readFile(f.path, "utf8").catch(() => undefined);
      if (text === undefined) {
        io.write(`✘ ${f.name}: journal not found\n`);
        broken += 1;
        continue;
      }
      const breaks = verifyEventChain(text);
      const lines = text.split("\n").filter((l) => l.trim() !== "").length;
      if (breaks.length === 0) io.write(`✔ ${f.name}: ${String(lines)} entries, chain intact\n`);
      else {
        broken += 1;
        io.write(
          `✘ ${f.name}: chain broken\n${breaks.map((b) => `  line ${String(b.line)}: ${b.reason}`).join("\n")}\n`,
        );
      }
    }
    return broken === 0 ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}
