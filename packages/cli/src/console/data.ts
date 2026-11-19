import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  AuditRecordSchema,
  listProjects,
  listTickets,
  projectPaths,
  qajitsuHome,
  readRunIndex,
  resolveWorkspaceRoot,
  RunIdSchema,
  RunRecordSchema,
  TicketKeySchema,
  type RunRecord,
  type TicketKey,
} from "@qajitsu/core";
import { loadProject } from "../project.js";

/** A project as the console lists it. */
export interface ConsoleProject {
  readonly slug: string;
  readonly qaDir: string;
  /** The project's runs root, or why it could not be read. */
  readonly runsRoot?: string | undefined;
  readonly problem?: string | undefined;
}

/** One run in a ticket's list. */
export interface ConsoleRunEntry {
  readonly runId: string;
  readonly createdAt: string;
  readonly status: string;
}

/** What a run's page shows: read from its files, nothing computed (REQ-WEB-01/AC2). */
export interface ConsoleRun {
  readonly record: RunRecord;
  /** Case statuses as the run computed and stored them (`run.json` data.results). */
  readonly results: Readonly<Record<string, string>>;
  readonly matrixMd?: string | undefined;
  readonly hasReport: boolean;
  readonly evidence: readonly {
    readonly path: string;
    readonly kind: string;
    readonly sha256: string;
    readonly bytes: number;
  }[];
  /** Plan versions on disk, newest last, and the approved one. */
  readonly planVersions: readonly number[];
  readonly approvedVersion?: number | undefined;
  readonly audit?: string | undefined;
  readonly publishedUrl?: string | undefined;
}

/**
 * The registered projects with their runs roots (REQ-WEB-01/AC1): a project whose configuration does not load is
 * listed with the reason.
 *
 * @param env - The environment (`QAJITSU_HOME`).
 * @param userHome - The user's home: the default QAJitsu home and `~` in configured paths.
 */
export async function consoleProjects(
  env: Readonly<Record<string, string | undefined>>,
  userHome: string,
): Promise<ConsoleProject[]> {
  const qjHome = qajitsuHome(env, userHome);
  const out: ConsoleProject[] = [];
  for (const record of await listProjects(qjHome)) {
    try {
      const project = await loadProject(dirname(record.qa_dir), {
        slug: record.slug,
        record,
        paths: projectPaths(qjHome, record.slug),
        via: "console",
      });
      out.push({
        slug: record.slug,
        qaDir: record.qa_dir,
        runsRoot: resolveWorkspaceRoot({
          configured: project.config.workspace.root,
          home: userHome,
          cwd: project.qaDir,
        }),
      });
    } catch (error) {
      out.push({
        slug: record.slug,
        qaDir: record.qa_dir,
        problem: error instanceof Error ? error.message.split("\n")[0] : "the configuration does not load",
      });
    }
  }
  return out;
}

/** A project's tickets with their latest run, newest first. */
export async function consoleTickets(
  runsRoot: string,
): Promise<
  { readonly ticket: TicketKey; readonly latest?: ConsoleRunEntry | undefined; readonly runs: number }[]
> {
  const out = [];
  for (const ticket of await listTickets(runsRoot)) {
    const index = await readRunIndex(runsRoot, ticket);
    const latest = index.runs.at(-1);
    out.push({
      ticket,
      runs: index.runs.length,
      ...(latest
        ? { latest: { runId: latest.runId, createdAt: latest.createdAt, status: latest.status } }
        : {}),
    });
  }
  return out.sort((a, b) => (b.latest?.createdAt ?? "").localeCompare(a.latest?.createdAt ?? ""));
}

/** A ticket's runs, newest first. */
export async function consoleRuns(runsRoot: string, ticket: string): Promise<ConsoleRunEntry[]> {
  const key = TicketKeySchema.parse(ticket);
  return (await readRunIndex(runsRoot, key)).runs
    .map((r) => ({ runId: r.runId, createdAt: r.createdAt, status: r.status }))
    .reverse();
}

const json = async (file: string): Promise<unknown> => {
  try {
    return JSON.parse(await readFile(file, "utf8")) as unknown;
  } catch {
    return undefined;
  }
};

/**
 * One run as its files hold it (REQ-WEB-01/AC1+AC2): the record, the statuses the run computed, the matrix and
 * report it wrote, the evidence manifest, the plan versions and the audit and publish records. Nothing is computed.
 *
 * @param runsRoot - The project's runs root.
 * @param ticket - The ticket key.
 * @param runId - The run id.
 */
export async function consoleRun(
  runsRoot: string,
  ticket: string,
  runId: string,
): Promise<ConsoleRun | undefined> {
  const dir = join(runsRoot, TicketKeySchema.parse(ticket), RunIdSchema.parse(runId));
  const record = RunRecordSchema.safeParse(await json(join(dir, "run.json")));
  if (!record.success) return undefined;
  const data = record.data.data;
  const results =
    typeof data["results"] === "object" && data["results"] !== null
      ? Object.fromEntries(
          Object.entries(data["results"] as Record<string, unknown>).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        )
      : {};
  const manifest = await json(join(dir, "evidence", "manifest.json"));
  const evidence = Array.isArray(manifest)
    ? manifest.flatMap((m: unknown) => {
        const e = m as { path?: unknown; kind?: unknown; sha256?: unknown; bytes?: unknown };
        return typeof e.path === "string" && typeof e.sha256 === "string"
          ? [
              {
                path: e.path,
                kind: typeof e.kind === "string" ? e.kind : "",
                sha256: e.sha256,
                bytes: Number(e.bytes ?? 0),
              },
            ]
          : [];
      })
    : [];
  const planFiles = await readdir(join(dir, "plan")).catch(() => [] as string[]);
  const planVersions = planFiles
    .map((f) => /^plan\.v(\d+)\.yaml$/.exec(f)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b);
  const approved = data["approval"] as { version?: unknown } | undefined;
  const audit = AuditRecordSchema.safeParse(await json(join(dir, "checks", "audit.json")));
  const publish = data["publish"] as { url?: unknown } | undefined;
  return {
    record: record.data,
    results,
    matrixMd: await readFile(join(dir, "report", "matrix.md"), "utf8").catch(() => undefined),
    hasReport: await stat(join(dir, "report", "report.html"))
      .then((i) => i.isFile())
      .catch(() => false),
    evidence,
    planVersions,
    ...(typeof approved?.version === "number" ? { approvedVersion: approved.version } : {}),
    ...(audit.success ? { audit: audit.data.status } : {}),
    ...(typeof publish?.url === "string" ? { publishedUrl: publish.url } : {}),
  };
}

/** A plan version's Markdown as the plan stage wrote it (`plan/plan.v<n>.md`). */
export async function consolePlan(
  runsRoot: string,
  ticket: string,
  runId: string,
  version: number,
): Promise<string | undefined> {
  if (!Number.isInteger(version) || version < 1) return undefined;
  const dir = join(runsRoot, TicketKeySchema.parse(ticket), RunIdSchema.parse(runId), "plan");
  return readFile(join(dir, `plan.v${String(version)}.md`), "utf8").catch(() => undefined);
}
