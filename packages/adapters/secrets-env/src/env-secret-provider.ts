import { readFile } from "node:fs/promises";
import { AdapterError, parseSecretRef, type SecretProvider } from "@qajitsu/core";

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parses `.env` syntax: `KEY=value`, optional `export `, single or double quotes, `#` comments.
 * Double-quoted values support `\n`; nothing is interpolated.
 *
 * @param text - File content.
 * @returns Variables in file order; later keys win.
 */
export function parseDotenv(text: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const body = line.startsWith("export ") ? line.slice(7).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) continue;
    const key = body.slice(0, eq).trim();
    if (!NAME.test(key)) continue;
    let value = body.slice(eq + 1).trim();
    const quote = value.charAt(0);
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length >= 2) {
      value = value.slice(1, -1);
      if (quote === '"') value = value.replaceAll("\\n", "\n");
    } else {
      const hash = value.indexOf(" #");
      if (hash >= 0) value = value.slice(0, hash).trimEnd();
    }
    result[key] = value;
  }
  return result;
}

/**
 * Creates the `env` secret provider. The process environment wins over `.env.local`.
 *
 * @param options - Environment, optional path of `.env.local` and an injectable file reader.
 * @example
 * const provider = createEnvSecretProvider({ env: process.env, envFile: join(cwd, ".env.local") });
 */
export function createEnvSecretProvider(options: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly envFile?: string;
  readonly readText?: (path: string) => Promise<string>;
}): SecretProvider {
  const readText = options.readText ?? ((path: string) => readFile(path, "utf8"));
  let fileVars: Promise<Record<string, string>> | undefined;
  const loadFile = (): Promise<Record<string, string>> => {
    const { envFile } = options;
    if (envFile === undefined) return Promise.resolve({});
    fileVars ??= readText(envFile).then(parseDotenv, (error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new AdapterError("SECRET_SOURCE_UNREADABLE", "Cannot read the .env.local file.", {
        file: envFile,
      });
    });
    return fileVars;
  };
  return {
    scheme: "env",
    async resolve(reference, signal) {
      signal?.throwIfAborted();
      const { provider, path } = parseSecretRef(reference);
      if (provider !== "env" || !NAME.test(path)) {
        throw new AdapterError("SECRET_REF_INVALID", "Expected secret://env/<VARIABLE_NAME>.", { provider });
      }
      const value = options.env[path] ?? (await loadFile())[path];
      if (value === undefined || value === "") {
        throw new AdapterError(
          "SECRET_NOT_FOUND",
          `Secret ${path} is not set in the environment or .env.local.`,
          {
            name: path,
          },
        );
      }
      return value;
    },
  };
}
