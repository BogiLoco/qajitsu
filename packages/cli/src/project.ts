import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError, parseProjectConfig, type ProjectConfig, type ResolvedProject } from "@qajitsu/core";
import { parse } from "yaml";

/** A loaded project: validated config plus where it lives. */
export interface LoadedProject {
  readonly config: ProjectConfig;
  /** Absolute path of the `.qa/` folder. */
  readonly qaDir: string;
  /** Repository (or folder) that contains `.qa/`. */
  readonly projectDir: string;
  /** The registered project, when the command resolved one (ADR-0006). */
  readonly project?: ResolvedProject;
}

const readConfig = async (dir: string): Promise<ProjectConfig> => {
  const file = join(dir, ".qa", "qa.project.yaml");
  let raw: unknown;
  try {
    raw = parse(await readFile(file, "utf8")) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    throw new ConfigError("CONFIG_YAML_INVALID", `${file} is not valid YAML.`, {
      file,
      cause: error instanceof Error ? error.message.split("\n")[0] : String(error),
    });
  }
  return parseProjectConfig(raw, file);
};

/**
 * Loads and validates the configuration of a project (REQ-GEN-01). With a resolved project (every CLI command,
 * ADR-0006) it is the project's own `.qa/` folder, and run folders and git mirrors default to the project home
 * (REQ-WS-01/AC4, REQ-CTX-04/AC1); without one (library use and tests) the first `.qa/` in `cwd` or a parent.
 *
 * @param cwd - Starting folder when no project is given.
 * @param project - The project resolved for the command.
 * @param env - Environment, for the `QAJITSU_WORKSPACE` run-level override.
 * @throws {ConfigError} `CONFIG_NOT_FOUND`, `CONFIG_YAML_INVALID` or `CONFIG_INVALID`.
 */
export async function loadProject(
  cwd: string,
  project?: ResolvedProject,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<LoadedProject> {
  const workspaceOverride = env["QAJITSU_WORKSPACE"];
  const finish = (config: ProjectConfig, dir: string): LoadedProject => {
    const workspace = {
      ...config.workspace,
      ...(project && config.workspace.root === undefined ? { root: project.paths.runs } : {}),
      ...(project && config.workspace.git_cache === undefined ? { git_cache: project.paths.gitCache } : {}),
      // Run-level override (configuration layer 5): CI jobs share run folders through artifacts here.
      ...(workspaceOverride !== undefined && workspaceOverride !== "" ? { root: workspaceOverride } : {}),
    };
    return {
      config: { ...config, workspace },
      qaDir: join(dir, ".qa"),
      projectDir: dir,
      ...(project ? { project } : {}),
    };
  };
  if (project) {
    const dir = dirname(project.record.qa_dir);
    try {
      return finish(await readConfig(dir), dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new ConfigError(
        "CONFIG_NOT_FOUND",
        `Project ${project.slug} links ${project.record.qa_dir}, which has no qa.project.yaml.`,
        { project: project.slug },
      );
    }
  }
  let dir = resolve(cwd);
  for (;;) {
    try {
      return finish(await readConfig(dir), dir);
    } catch (error) {
      if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      throw new ConfigError("CONFIG_NOT_FOUND", "No .qa/qa.project.yaml found here or in a parent folder.", {
        cwd,
      });
    }
    dir = parent;
  }
}

/**
 * Resolves a configured path: `~/...` against home, relative paths against the `.qa/` folder.
 *
 * @param path - Path from configuration.
 * @param base - Folder relative paths start from.
 * @param home - Home directory.
 */
export function resolveConfigPath(path: string, base: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return isAbsolute(path) ? path : resolve(base, path);
}
