import { mkdir, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { z } from "zod";
import { ConfigError } from "../errors.js";

/** Project slugs (REQ-PRJ-01/AC3). */
export const ProjectSlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]{1,39}$/, "Slugs look like bank or shop-web");

/** `projects/<slug>/project.yaml`: identity of a project and its link to a `.qa/` folder (REQ-PRJ-01/AC2). */
export const ProjectRecordSchema = z.strictObject({
  schema: z.literal(1),
  slug: ProjectSlugSchema,
  /** Absolute path of the project's `.qa/` folder. */
  qa_dir: z.string().min(1),
  /** Jira key prefixes that select this project (`BANK` for `BANK-12`, REQ-PRJ-03/AC2). */
  jira_prefixes: z.array(z.string().regex(/^[A-Z][A-Z0-9_]{1,19}$/)).default([]),
  created_at: z.string(),
  /** Archived projects keep their home but are hidden from lists and prefix mapping (REQ-PRJ-07/AC5). */
  archived: z.boolean().default(false),
});

/** A registered project. */
export type ProjectRecord = z.infer<typeof ProjectRecordSchema>;

/** `config.yaml` of the QAJitsu home: global settings, never secrets (REQ-PRJ-01/AC5). */
const GlobalConfigSchema = z.strictObject({ schema: z.literal(1), active: ProjectSlugSchema.optional() });

/** Folders of a project home (REQ-PRJ-01/AC2). */
export interface ProjectPaths {
  readonly home: string;
  readonly record: string;
  readonly runs: string;
  readonly cache: string;
  readonly gitCache: string;
  readonly knowledge: string;
  readonly exports: string;
  readonly logs: string;
  readonly context: string;
}

/** A project resolved for a command, and how (REQ-PRJ-03/AC4). */
export interface ResolvedProject {
  readonly slug: string;
  readonly record: ProjectRecord;
  readonly paths: ProjectPaths;
  readonly via: string;
}

/**
 * The QAJitsu home: `QAJITSU_HOME`, else `~/.qajitsu` (REQ-PRJ-01/AC1).
 *
 * @param env - Process environment.
 * @param home - The user's home directory.
 */
export function qajitsuHome(env: Readonly<Record<string, string | undefined>>, home: string): string {
  const configured = env["QAJITSU_HOME"];
  return configured !== undefined && configured !== "" ? resolve(configured) : join(home, ".qajitsu");
}

const slugOf = (slug: string): string => {
  const parsed = ProjectSlugSchema.safeParse(slug);
  if (!parsed.success)
    throw new ConfigError(
      "PROJECT_SLUG_INVALID",
      `'${slug.slice(0, 40)}' is not a project slug (a-z, 0-9, -).`,
      {},
    );
  return parsed.data;
};

/**
 * Paths of a project home, built only from a validated slug (REQ-PRJ-01/AC2+AC3).
 *
 * @throws {ConfigError} `PROJECT_SLUG_INVALID`.
 */
export function projectPaths(qjHome: string, slug: string): ProjectPaths {
  const dir = join(qjHome, "projects", slugOf(slug));
  return {
    home: dir,
    record: join(dir, "project.yaml"),
    runs: join(dir, "runs"),
    cache: join(dir, "cache"),
    gitCache: join(dir, "cache", "git"),
    knowledge: join(dir, "knowledge"),
    exports: join(dir, "exports"),
    logs: join(dir, "logs"),
    context: join(dir, "context.json"),
  };
}

const writeYamlAtomic = async (file: string, value: unknown): Promise<void> => {
  const tmp = `${file}.tmp-${String(process.pid)}`;
  await writeFile(tmp, stringify(value), "utf8");
  await rename(tmp, file);
};

/**
 * Reads a registered project.
 *
 * @throws {ConfigError} `PROJECT_NOT_FOUND` or `PROJECT_INVALID`.
 */
export async function readProject(qjHome: string, slug: string): Promise<ProjectRecord> {
  const paths = projectPaths(qjHome, slug);
  let text: string;
  try {
    text = await readFile(paths.record, "utf8");
  } catch {
    throw new ConfigError(
      "PROJECT_NOT_FOUND",
      `No project '${slug}': create it with 'qajitsu init ${slug}'.`,
      {
        slug,
      },
    );
  }
  const parsed = ProjectRecordSchema.safeParse(parse(text));
  if (!parsed.success)
    throw new ConfigError("PROJECT_INVALID", `${paths.record} is not a valid project record.`, {});
  return parsed.data;
}

/** Every registered project, by slug; archived ones only with `includeArchived` (REQ-PRJ-07/AC5). */
export async function listProjects(
  qjHome: string,
  options: { readonly includeArchived?: boolean } = {},
): Promise<ProjectRecord[]> {
  const slugs = (await readdir(join(qjHome, "projects")).catch(() => [] as string[])).sort();
  const out: ProjectRecord[] = [];
  for (const slug of slugs) {
    if (!ProjectSlugSchema.safeParse(slug).success) continue;
    const record = await readProject(qjHome, slug).catch(() => undefined);
    if (record && (!record.archived || options.includeArchived === true)) out.push(record);
  }
  return out;
}

/**
 * Registers a project and creates its home (REQ-PRJ-01, REQ-PRJ-02/AC1+AC5). An existing slug is left unchanged
 * unless `force`; runs, caches and knowledge are never deleted.
 *
 * @throws {ConfigError} `PROJECT_SLUG_INVALID`, `PROJECT_EXISTS`.
 */
export async function registerProject(
  qjHome: string,
  options: {
    readonly slug: string;
    readonly qaDir: string;
    readonly jiraPrefixes?: readonly string[];
    readonly force?: boolean;
    readonly now?: () => Date;
  },
): Promise<ProjectRecord> {
  const paths = projectPaths(qjHome, options.slug);
  const existing = await readProject(qjHome, options.slug).catch(() => undefined);
  if (existing && options.force !== true)
    throw new ConfigError("PROJECT_EXISTS", `Project '${options.slug}' exists; use --force to relink it.`, {
      slug: options.slug,
    });
  if (!isAbsolute(options.qaDir))
    throw new ConfigError("PROJECT_QA_DIR_INVALID", "The .qa/ folder must be given as an absolute path.", {});
  const record = ProjectRecordSchema.parse({
    schema: 1,
    slug: options.slug,
    qa_dir: options.qaDir,
    jira_prefixes: [...(options.jiraPrefixes ?? existing?.jira_prefixes ?? [])],
    created_at: existing?.created_at ?? (options.now ?? (() => new Date()))().toISOString(),
    archived: false,
  });
  for (const dir of [paths.runs, paths.gitCache, paths.knowledge, paths.exports, paths.logs])
    await mkdir(dir, { recursive: true });
  await writeYamlAtomic(paths.record, record);
  return record;
}

const readGlobal = async (qjHome: string): Promise<z.infer<typeof GlobalConfigSchema>> => {
  try {
    return GlobalConfigSchema.parse(parse(await readFile(join(qjHome, "config.yaml"), "utf8")));
  } catch {
    return { schema: 1 };
  }
};

/** The active project's slug, if any (REQ-PRJ-03/AC1). */
export async function readActiveProject(qjHome: string): Promise<string | undefined> {
  return (await readGlobal(qjHome)).active;
}

/**
 * Sets the active project (`qj use`, REQ-PRJ-03/AC1).
 *
 * @throws {ConfigError} `PROJECT_NOT_FOUND`.
 */
export async function setActiveProject(qjHome: string, slug: string): Promise<void> {
  await readProject(qjHome, slug);
  await mkdir(qjHome, { recursive: true });
  await writeYamlAtomic(join(qjHome, "config.yaml"), { ...(await readGlobal(qjHome)), active: slug });
}

/**
 * Resolves the project of a command (REQ-PRJ-03/AC2+AC3, ADR-0006): `--project`, `QAJITSU_PROJECT`, the Jira key
 * prefix of the ticket, the active project. Never the current directory; a prefix of two projects is an error.
 *
 * @throws {ConfigError} `PROJECT_NOT_FOUND`, `PROJECT_PREFIX_AMBIGUOUS`, `PROJECT_NOT_SELECTED`.
 */
export async function resolveProject(
  qjHome: string,
  options: {
    readonly flag?: string | undefined;
    readonly env?: string | undefined;
    readonly ticket?: string | undefined;
  },
): Promise<ResolvedProject> {
  const found = async (slug: string, via: string): Promise<ResolvedProject> => ({
    slug,
    record: await readProject(qjHome, slug),
    paths: projectPaths(qjHome, slug),
    via,
  });
  if (options.flag !== undefined && options.flag !== "") return found(options.flag, "flag");
  if (options.env !== undefined && options.env !== "") return found(options.env, "QAJITSU_PROJECT");
  const prefix = /^([A-Z][A-Z0-9_]{1,19})-\d+$/.exec(options.ticket ?? "")?.[1];
  if (prefix !== undefined) {
    const matching = (await listProjects(qjHome)).filter((p) => p.jira_prefixes.includes(prefix));
    if (matching.length > 1)
      throw new ConfigError(
        "PROJECT_PREFIX_AMBIGUOUS",
        `Ticket prefix ${prefix} belongs to several projects (${matching.map((p) => p.slug).join(", ")}); choose one with --project.`,
        {},
      );
    const [only] = matching;
    if (only) return found(only.slug, `ticket prefix ${prefix}`);
  }
  const active = await readActiveProject(qjHome);
  if (active !== undefined) return found(active, "active project");
  throw new ConfigError(
    "PROJECT_NOT_SELECTED",
    "No project selected: create one with 'qajitsu init <slug>' or choose one with 'qajitsu use <slug>' or --project.",
    {},
  );
}

/**
 * Archives or restores a project (REQ-PRJ-07/AC5): the home stays, the project disappears from lists and from
 * ticket prefix mapping, and stops being the active project.
 *
 * @throws {ConfigError} `PROJECT_NOT_FOUND`.
 */
export async function setProjectArchived(
  qjHome: string,
  slug: string,
  archived: boolean,
): Promise<ProjectRecord> {
  const record = { ...(await readProject(qjHome, slug)), archived };
  await writeYamlAtomic(projectPaths(qjHome, slug).record, record);
  if (archived && (await readActiveProject(qjHome)) === slug) await clearActiveProject(qjHome);
  return record;
}

/** Clears the active project (after `projects remove` or `archive` of the active one). */
export async function clearActiveProject(qjHome: string): Promise<void> {
  const global = await readGlobal(qjHome);
  if (global.active === undefined) return;
  await mkdir(qjHome, { recursive: true });
  await writeYamlAtomic(join(qjHome, "config.yaml"), { schema: 1 });
}
