import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  AUDIT_DIR,
  APPROVED_PLAN_FILE,
  QajitsuError,
  parseEventLines,
  sha256,
  type ApprovalStep,
  type PlanApproval,
  RunIdSchema,
  TicketKeySchema,
  ConfigError,
  readRunIndex,
  resolveWorkspaceRoot,
  verifyEventChain,
} from "@qajitsu/core";
import { rebuildCall } from "@qajitsu/agents";
import { checkApprovalRecords } from "@qajitsu/verifier";
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
    const files: { name: string; path: string; runDir?: string }[] = [];
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
        files.push({
          name: `${key.data}/${id}`,
          path: exists ? live : archived,
          ...(exists ? { runDir: join(root, key.data, id) } : {}),
        });
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
      if (f.runDir !== undefined) {
        const approval = await checkRunApproval(f.runDir, text);
        const inputs = await checkRunInputs(f.runDir, text);
        if (inputs !== undefined) {
          if (inputs.problems.length === 0) io.write(`✔ ${f.name}: ${inputs.summary}\n`);
          else {
            broken += 1;
            io.write(`✘ ${f.name}: model inputs\n${inputs.problems.map((p) => `  ${p}`).join("\n")}\n`);
          }
        }
        if (approval === undefined) continue;
        if (approval.problems.length === 0) io.write(`✔ ${f.name}: approval ${approval.summary}\n`);
        else {
          broken += 1;
          io.write(`✘ ${f.name}: approval records\n${approval.problems.map((p) => `  ${p}`).join("\n")}\n`);
        }
      }
    }
    return broken === 0 ? 0 : 1;
  } catch (error) {
    const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
    io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 3;
  }
}

/**
 * Rebuilds the input of every model call in a journal from its snapshot and the fragment texts the run kept
 * (REQ-CTX-17/AC4) and reports differences by fragment.
 *
 * @param journal - The run's journal.
 * @param readText - The kept text of a fragment by its hash.
 * @returns Nothing when the run kept no fragment texts (older runs) or made no model calls.
 */
export function rebuildInputs(
  journal: string,
  readText: (sha256: string) => string | undefined,
): { summary: string; problems: string[] } | undefined {
  const calls = parseEventLines(journal).events.filter((e) => e.event === "context.snapshot");
  if (calls.length === 0) return undefined;
  const problems: string[] = [];
  let found = 0;
  calls.forEach((e, i) => {
    const call = `call ${String(i + 1)} (${e.stage}/${e.actor.name})`;
    try {
      const rebuilt = rebuildCall(e.details, (h) => {
        const text = readText(h);
        if (text !== undefined) found += 1;
        return text;
      });
      if (!rebuilt.snapshotIntact) problems.push(`${call}: the snapshot does not match its own hash`);
      for (const f of rebuilt.fragments.filter((x) => x.status !== "same"))
        problems.push(`${call}: ${f.kind} ${f.source} ${f.status} (sha256 ${f.sha256.slice(0, 12)})`);
    } catch {
      problems.push(`${call}: the snapshot cannot be read`);
    }
  });
  if (found === 0) return undefined;
  return { summary: `${String(calls.length)} model input(s) rebuilt from their snapshots`, problems };
}

/** {@link rebuildInputs} for a live run folder. */
async function checkRunInputs(
  runDir: string,
  journal: string,
): Promise<{ summary: string; problems: string[] } | undefined> {
  const dir = join(runDir, "context", "fragments");
  const texts = new Map<string, string>();
  for (const name of await readdir(dir).catch(() => [] as string[]))
    texts.set(name.replace(/\.txt$/, ""), await readFile(join(dir, name), "utf8"));
  return rebuildInputs(journal, (h) => texts.get(h));
}

/**
 * Checks the approval of a live run (REQ-PLAN-10/AC6, ADR-0010): the approved plan file still has the recorded
 * SHA-256, and the approval steps in `run.json` match the journal.
 *
 * @returns Nothing for a run without an approved plan.
 */
async function checkRunApproval(
  runDir: string,
  journal: string,
): Promise<{ summary: string; problems: string[] } | undefined> {
  const record = JSON.parse(await readFile(join(runDir, "run.json"), "utf8").catch(() => "{}")) as {
    data?: { approval?: PlanApproval; approvals?: unknown };
  };
  const approval = record.data?.approval;
  if (approval === undefined) return undefined;
  const steps = Array.isArray(record.data?.approvals) ? (record.data.approvals as ApprovalStep[]) : [];
  const check = checkApprovalRecords(approval, steps, parseEventLines(journal).events);
  const file = await readFile(join(runDir, "plan", APPROVED_PLAN_FILE), "utf8").catch(() => undefined);
  const problems = [
    ...(file === undefined
      ? [`${APPROVED_PLAN_FILE} is missing`]
      : sha256(file) === approval.sha256
        ? []
        : [`${APPROVED_PLAN_FILE} does not match the approved sha256 ${approval.sha256.slice(0, 12)}`]),
    ...check.problems,
  ];
  const by = check.modelOnly
    ? `by a model only (${approval.approver.replace(/^model:/, "")})`
    : `by ${approval.approver}`;
  return {
    summary: `of plan v${String(approval.version)} ${by}, ${String(steps.length)} step(s) match the journal`,
    problems,
  };
}
