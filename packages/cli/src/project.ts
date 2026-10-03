import { readFile, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { ConfigError, parseProjectConfig, type ProjectConfig } from "@qajitsu/core";
import { parse } from "yaml";

/** A loaded project: validated config plus where it lives. */
export interface LoadedProject {
  readonly config: ProjectConfig;
  /** Absolute path of the `.qa/` folder. */
  readonly qaDir: string;
  /** Repository (or folder) that contains `.qa/`. */
  readonly projectDir: string;
}

/**
 * Finds `.qa/qa.project.yaml` in `cwd` or a parent folder and validates it (REQ-GEN-01).
 *
 * @param cwd - Starting folder.
 * @throws {ConfigError} `CONFIG_NOT_FOUND`, `CONFIG_YAML_INVALID` or `CONFIG_INVALID`.
 */
export async function loadProject(cwd: string): Promise<LoadedProject> {
  let dir = resolve(cwd);
  for (;;) {
    const file = join(dir, ".qa", "qa.project.yaml");
    try {
      await stat(file);
      let raw: unknown;
      try {
        raw = parse(await readFile(file, "utf8")) as unknown;
      } catch (error) {
        throw new ConfigError("CONFIG_YAML_INVALID", `${file} is not valid YAML.`, {
          file,
          cause: error instanceof Error ? error.message.split("\n")[0] : String(error),
        });
      }
      return { config: parseProjectConfig(raw, file), qaDir: join(dir, ".qa"), projectDir: dir };
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
