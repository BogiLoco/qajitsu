import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  ConfigError,
  ProjectProfileSchema,
  QajitsuError,
  collectQaFiles,
  maskCredentials,
  projectPaths,
  qajitsuHome,
  readKnowledgeSources,
  readProject,
  registerProject,
  writeKnowledgeSources,
  type ProjectProfile,
  type ResolvedProject,
} from "@qajitsu/core";
import { createMasker } from "@qajitsu/steps";
import { parse, stringify } from "yaml";
import { createCliSecretResolver, type RuntimePorts } from "../adapters.js";
import { loadProject } from "../project.js";
import { registerConfiguredSecrets } from "../session.js";
import type { CommandIO } from "./fetch.js";

const fail = (io: CommandIO, error: unknown): number => {
  const code = error instanceof QajitsuError ? ` [${error.code}]` : "";
  io.writeError(`Error${code}: ${error instanceof Error ? error.message : String(error)}\n`);
  return 3;
};

const writeAtomic = async (file: string, text: string): Promise<void> => {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${String(process.pid)}`;
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 });
  await rename(tmp, file);
};

/**
 * `qajitsu projects export <slug> [--out <file>]`: writes the project profile, the text files of its `.qa/` folder and
 * its knowledge sources to one YAML file (REQ-PRJ-09/AC1). Never the knowledge index or runs; environment and key
 * files are left out, and the export is refused when any file holds a secret value of the project or something that
 * looks like a credential. Default output: `<project-home>/exports/<slug>.profile.yaml`.
 *
 * @returns 0 written, 3 refused or errors.
 */
export async function runProjectExport(
  slug: string,
  options: { readonly out?: string | undefined },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const home = qajitsuHome(ports.env, ports.home);
    const record = await readProject(home, slug);
    const paths = projectPaths(home, slug);
    const resolved: ResolvedProject = { slug, record, paths, via: "export" };
    const { files, skipped } = await collectQaFiles(record.qa_dir);
    // Secret values of the project are registered from its configuration and environment profiles.
    const masker = createMasker();
    const project = await loadProject(dirname(record.qa_dir), resolved).catch(() => undefined);
    if (project) await registerConfiguredSecrets(project, createCliSecretResolver(project, ports, masker));
    const leaking = files
      .filter((f) => masker.containsSecret(f.text) || maskCredentials(f.text) !== f.text)
      .map((f) => f.path);
    if (leaking.length > 0)
      throw new ConfigError(
        "PROFILE_CONTAINS_SECRET",
        `Not exported: ${leaking.join(", ")} contain${leaking.length === 1 ? "s" : ""} a secret value or a credential. Replace it with a secret:// reference.`,
        { files: leaking },
      );
    const profile: ProjectProfile = {
      schema: 1,
      kind: "qajitsu-project-profile",
      exported_at: ports.now().toISOString(),
      slug,
      jira_prefixes: record.jira_prefixes,
      qa_dir: record.qa_dir,
      qa_files: files,
      knowledge_sources: (await readKnowledgeSources(paths.knowledge)).map((s) => {
        const copy = { ...s };
        delete copy.synced_at;
        return copy;
      }),
    };
    const out =
      options.out === undefined
        ? join(paths.exports, `${slug}.profile.yaml`)
        : isAbsolute(options.out)
          ? options.out
          : resolve(io.cwd, options.out);
    await writeAtomic(out, stringify(profile, { lineWidth: 0 }));
    io.write(
      `Exported project ${slug}: ${String(files.length)} .qa/ file(s), ${String(profile.knowledge_sources.length)} knowledge source(s); no index, runs or secrets.\n${out}\n`,
    );
    for (const s of skipped) io.write(`  left out .qa/${s.path}: ${s.reason}\n`);
    return 0;
  } catch (error) {
    return fail(io, error);
  }
}

/** Rewrites a path by the first matching `old=new` prefix mapping. */
const mapPath = (path: string, maps: readonly (readonly [string, string])[]): string => {
  for (const [from, to] of maps)
    if (path === from || path.startsWith(`${from}/`)) return `${to}${path.slice(from.length)}`;
  return path;
};

/**
 * `qajitsu projects import <file>`: recreates a project from a profile (REQ-PRJ-09/AC2). An existing `.qa/` folder
 * at the target is linked as it is; otherwise the profile's `.qa/` files are written there. Knowledge sources are
 * registered (paths rewritten with `--map-path old=new`) and rebuilt by `qj knowledge sync`. Secrets are never in a
 * profile: they go into `.env.local` or the secret manager on the new machine.
 *
 * @returns 0 imported, 2 imported but some knowledge sources are missing, 3 errors.
 */
export async function runProjectImport(
  file: string,
  options: {
    readonly qaDir?: string | undefined;
    readonly slug?: string | undefined;
    readonly force?: boolean | undefined;
    readonly mapPath?: readonly string[] | undefined;
  },
  io: CommandIO,
  ports: RuntimePorts,
): Promise<number> {
  try {
    const parsed = ProjectProfileSchema.safeParse(
      parse(await readFile(isAbsolute(file) ? file : resolve(io.cwd, file), "utf8")),
    );
    if (!parsed.success)
      throw new ConfigError("PROFILE_INVALID", `${file} is not a QAJitsu project profile.`, {
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      });
    const profile = parsed.data;
    const slug = options.slug ?? profile.slug;
    const maps = (options.mapPath ?? []).map((m) => {
      const at = m.indexOf("=");
      if (at <= 0) throw new ConfigError("MAP_PATH_INVALID", `--map-path needs old=new, got '${m}'.`, {});
      return [m.slice(0, at).replace(/\/+$/, ""), m.slice(at + 1).replace(/\/+$/, "")] as const;
    });
    const qaDir = options.qaDir ? resolve(io.cwd, options.qaDir) : mapPath(profile.qa_dir, maps);
    const existing = await stat(join(qaDir, "qa.project.yaml")).catch(() => undefined);
    let written = 0;
    if (!existing) {
      if (profile.qa_files.length === 0)
        throw new ConfigError(
          "PROFILE_WITHOUT_QA",
          `No .qa/ at ${qaDir} and the profile carries none; pass --qa-dir.`,
          {},
        );
      for (const f of profile.qa_files) {
        const target = resolve(qaDir, f.path);
        const rel = relative(qaDir, target);
        if (rel.startsWith("..") || isAbsolute(rel))
          throw new ConfigError("PROFILE_PATH_INVALID", `Refused .qa/ path ${f.path}.`, {});
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, f.text, { flag: "wx" });
        written += 1;
      }
    }
    const home = qajitsuHome(ports.env, ports.home);
    await registerProject(home, {
      slug,
      qaDir,
      jiraPrefixes: profile.jira_prefixes,
      force: options.force === true,
      now: ports.now,
    });
    const knowledge = projectPaths(home, slug).knowledge;
    const already = await readKnowledgeSources(knowledge);
    const sources = profile.knowledge_sources.map((s) => ({ ...s, path: mapPath(s.path, maps) }));
    const missing: string[] = [];
    for (const s of sources)
      if (!(await stat(s.path).catch(() => undefined))) missing.push(`${s.name} (${s.path})`);
    if (sources.length > 0 && (already.length === 0 || options.force === true))
      await writeKnowledgeSources(knowledge, sources);
    io.write(
      [
        `Imported project ${slug}: ${existing ? `linked the existing .qa/ at ${qaDir}` : `wrote ${String(written)} .qa/ file(s) to ${qaDir}`}, ${String(sources.length)} knowledge source(s).`,
        "Next: put the secrets into .env.local next to .qa/ (or the secret manager), run 'qajitsu doctor',",
        `then 'qajitsu --project ${slug} knowledge sync' to rebuild the knowledge base.`,
        ...missing.map(
          (m) => `  missing knowledge source ${m}: fix with --map-path or 'qajitsu knowledge remove'`,
        ),
      ].join("\n") + "\n",
    );
    return missing.length > 0 ? 2 : 0;
  } catch (error) {
    return fail(io, error);
  }
}
