import { cp, lstat, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  QajitsuError,
  TicketKeySchema,
  clearActiveProject,
  listProjects,
  projectPaths,
  qajitsuHome,
  readActiveProject,
  readProject,
  readRunIndex,
  registerProject,
  setActiveProject,
  setProjectArchived,
  type ProjectRecord,
} from "@qajitsu/core";
import type { RuntimePorts } from "../adapters.js";
import { projectChecks } from "../doctor-project.js";
import { loadProject } from "../project.js";
import type { CommandIO } from "./fetch.js";
import { runInit } from "./init.js";
import { removeRun } from "./runs.js";
import type { CommandExec } from "@qajitsu/adapter-env-compose";

const fail = (io: CommandIO, error: unknown): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  return 3;
};

const exists = (path: string): Promise<boolean> =>
  stat(path).then(
    () => true,
    () => false,
  );

/** Options of `qajitsu init <slug>`. */
export interface ProjectInitOptions {
  /** The `.qa/` folder to link or create (default `./.qa`). */
  readonly qaDir?: string | undefined;
  /** Jira key prefixes of the project (default: `jira.project_key` of its config). */
  readonly jiraPrefix?: readonly string[] | undefined;
  readonly yes?: boolean | undefined;
  readonly force?: boolean | undefined;
  /** `false` with `--no-use`: register without making it the active project. */
  readonly use?: boolean | undefined;
  readonly jiraUrl?: string | undefined;
  readonly projectKey?: string | undefined;
  readonly envUrl?: string | undefined;
}

/** Tickets and runs of a project, read from its run folders (the start of `qj status`, REQ-PRJ-05). */
async function openWork(record: ProjectRecord, home: string): Promise<{ tickets: number; runs: number }> {
  const root = projectPaths(home, record.slug).runs;
  let tickets = 0;
  let runs = 0;
  for (const ticket of await readdir(root).catch(() => [] as string[])) {
    const index = await readFile(join(root, ticket, "index.json"), "utf8").catch(() => undefined);
    if (index === undefined) continue;
    tickets += 1;
    runs += ((JSON.parse(index) as { runs?: unknown[] }).runs ?? []).length;
  }
  return { tickets, runs };
}

/**
 * `qajitsu init <slug> [--qa-dir <path>] [--jira-prefix <KEY>]... [--yes] [--force] [--no-use]`: registers a project
 * (REQ-PRJ-02): creates its home (REQ-PRJ-01), links an existing `.qa/` or creates one by detection (REQ-GEN-03),
 * validates it and reports every problem, and makes it the active project. An invalid project is registered and
 * reported as not ready. Nothing is indexed (REQ-PRJ-02/AC6).
 *
 * @returns 0 when registered and ready, 2 when registered but not ready, 3 on errors.
 */
export async function runProjectInit(
  slug: string,
  options: ProjectInitOptions,
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const home = qajitsuHome(ports.env, ports.home);
    const qaDir = resolve(io.cwd, options.qaDir ?? ".qa");
    const existing = await readProject(home, slug).catch(() => undefined);
    if (existing && options.force !== true) {
      io.write(
        `Project ${slug} already exists (${existing.qa_dir}); nothing changed. Use --force to relink it.\n`,
      );
      return 0;
    }
    if (!(await exists(join(qaDir, "qa.project.yaml")))) {
      // REQ-PRJ-02/AC2: no configuration yet: create it from what the repository contains.
      const created = await runInit(
        {
          yes: options.yes,
          jiraUrl: options.jiraUrl,
          projectKey: options.projectKey,
          envUrl: options.envUrl,
        },
        { ...io, cwd: dirname(qaDir) },
      );
      if (created !== 0) return created;
    }
    const problems: string[] = [];
    let prefixes = [...(options.jiraPrefix ?? [])].map((p) => p.toUpperCase());
    try {
      const project = await loadProject(dirname(qaDir));
      if (prefixes.length === 0 && project.config.jira.project_key)
        prefixes = [project.config.jira.project_key];
      for (const check of await projectChecks(project, ports, { online: false }))
        if (!check.ok) problems.push(`${check.name}: ${check.detail}`);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    const record = await registerProject(home, {
      slug,
      qaDir,
      jiraPrefixes: prefixes,
      force: options.force === true,
      now: ports.now,
    });
    if (options.use !== false) await setActiveProject(home, slug);
    io.write(
      [
        `Project ${record.slug} registered: ${projectPaths(home, slug).home}`,
        `  configuration: ${record.qa_dir}`,
        `  ticket prefixes: ${record.jira_prefixes.join(", ") || "(none: use --project)"}`,
        options.use !== false ? "  active project: yes" : "  active project: no (qajitsu use to switch)",
        problems.length === 0 ? "  ready" : `  NOT READY:\n${problems.map((p) => `    ✘ ${p}`).join("\n")}`,
        "",
      ].join("\n"),
    );
    return problems.length === 0 ? 0 : 2;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qajitsu use <slug>`: makes a project active and shows its open work (REQ-PRJ-03/AC1+AC5).
 *
 * @returns 0, or 3 when the project does not exist.
 */
export async function runUse(slug: string, io: CommandIO, ports: RuntimePorts): Promise<number> {
  try {
    const home = qajitsuHome(ports.env, ports.home);
    await setActiveProject(home, slug);
    const record = await readProject(home, slug);
    const work = await openWork(record, home);
    io.write(
      `Active project: ${slug} (${record.qa_dir})\n  ${String(work.tickets)} ticket(s), ${String(work.runs)} run(s)\n`,
    );
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qajitsu projects list` and `qajitsu projects current` (REQ-PRJ-03/AC1).
 *
 * @returns 0, or 3 when `current` has no active project.
 */
export async function runProjects(
  which: "list" | "current",
  io: CommandIO,
  ports: RuntimePorts,
  includeArchived = false,
): Promise<number> {
  try {
    const home = qajitsuHome(ports.env, ports.home);
    const active = await readActiveProject(home);
    if (which === "current") {
      if (active === undefined) {
        io.writeError("No active project: choose one with 'qajitsu use <slug>'.\n");
        return 3;
      }
      io.write(`${active}\n`);
      return 0;
    }
    const projects = await listProjects(home, { includeArchived });
    if (projects.length === 0) {
      io.write("No projects yet: create one with 'qajitsu init <slug>'.\n");
      return 0;
    }
    for (const p of projects) {
      const ready = await loadProject(dirname(p.qa_dir)).then(
        () => "ready",
        () => "not ready",
      );
      const work = await openWork(p, home);
      io.write(
        `${p.slug === active ? "*" : " "} ${p.slug}  ${p.archived ? "archived" : ready}  prefixes ${p.jira_prefixes.join(",") || "-"}  ${String(work.tickets)} ticket(s), ${String(work.runs)} run(s)  ${p.qa_dir}\n`,
      );
    }
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/** Total size in bytes and file count of a folder (symbolic links not followed). */
async function sizeOf(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true }).catch(() => [])) {
    if (!entry.isFile()) continue;
    files += 1;
    bytes += (await lstat(join(entry.parentPath, entry.name)).catch(() => ({ size: 0 }))).size;
  }
  return { bytes, files };
}

const mb = (bytes: number): string => `${(bytes / 1_048_576).toFixed(1)} MB`;

/**
 * `qajitsu projects remove <slug> [--dry-run] [--yes] [--delete-audit]`: deletes a project home after confirmation
 * (REQ-PRJ-07/AC3+AC4). Runtime resources of its runs are removed first and their journals are archived to
 * `<qajitsu-home>/audit/<slug>/` (kept unless `--delete-audit`). The repository's `.qa/` folder and data in the
 * system under test are never touched.
 *
 * @returns 0 removed or listed, 3 not confirmed or errors.
 */
export async function runProjectRemove(
  slug: string,
  options: {
    readonly dryRun?: boolean | undefined;
    readonly yes?: boolean | undefined;
    readonly deleteAudit?: boolean | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts & { readonly buildExec?: CommandExec },
): Promise<number> {
  try {
    const home = qajitsuHome(ports.env, ports.home);
    const record = await readProject(home, slug);
    const paths = projectPaths(home, slug);
    const parts = await Promise.all(
      (["runs", "cache", "knowledge", "exports", "logs"] as const).map(async (k) => ({
        name: k,
        ...(await sizeOf(paths[k])),
      })),
    );
    const total = parts.reduce((n, p) => n + p.bytes, 0);
    const tickets = (await readdir(paths.runs).catch(() => [] as string[])).filter(
      (t) => TicketKeySchema.safeParse(t).success,
    );
    io.write(
      [
        `Project ${slug}: ${paths.home} (${mb(total)})`,
        ...parts.map(
          (p) => `  ${p.name.padEnd(9)} ${String(p.files).padStart(6)} file(s) ${mb(p.bytes).padStart(10)}`,
        ),
        `  tickets with runs: ${String(tickets.length)}`,
        `  kept: ${record.qa_dir} (the repository's configuration)${options.deleteAudit === true ? "" : `, run journals in ${join(home, "audit", slug)}`}`,
        "",
      ].join("\n"),
    );
    if (options.dryRun === true) return 0;
    if (options.yes !== true) {
      const answer = io.ask
        ? (await io.ask(`Type the project name (${slug}) to delete its home: `)).trim()
        : "";
      if (answer !== slug) {
        io.writeError(
          io.ask
            ? "Not confirmed; nothing deleted.\n"
            : "Not confirmed: pass --yes to delete without a terminal.\n",
        );
        return 3;
      }
    }
    // Runs first: containers and worktrees go, journals are archived under the project's run root.
    for (const ticket of tickets) {
      const key = TicketKeySchema.parse(ticket);
      for (const r of (await readRunIndex(paths.runs, key)).runs)
        io.write(`${await removeRun(paths.runs, key, r.runId, ports.buildExec)}\n`);
    }
    const audit = join(paths.runs, ".audit");
    if (options.deleteAudit !== true && (await readdir(audit).catch(() => [])).length > 0) {
      const target = join(home, "audit", slug);
      await mkdir(dirname(target), { recursive: true });
      await cp(audit, target, { recursive: true, force: false, errorOnExist: false });
    }
    await rm(paths.home, { recursive: true, force: true });
    if ((await readActiveProject(home)) === slug) await clearActiveProject(home);
    io.write(`Project ${slug} removed.\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/**
 * `qajitsu projects archive|unarchive <slug>`: hides a project from lists and ticket prefix mapping without deleting
 * anything (REQ-PRJ-07/AC5).
 *
 * @returns 0, or 3 on errors.
 */
export async function runProjectArchive(
  slug: string,
  archived: boolean,
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    await setProjectArchived(qajitsuHome(ports.env, ports.home), slug, archived);
    io.write(
      archived
        ? `Project ${slug} archived: hidden from lists and ticket prefixes; its home stays.\n`
        : `Project ${slug} restored.\n`,
    );
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}
