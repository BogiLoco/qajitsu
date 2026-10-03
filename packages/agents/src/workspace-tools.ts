import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentTool } from "./loop.js";

/** Lines returned by one `read_file` call at most. */
export const READ_FILE_MAX_LINES = 400;
/** Matches returned by one `search_code` call at most. */
export const SEARCH_MAX_MATCHES = 50;

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".next", "vendor"]);

/**
 * Paths agents may never read, even read-only: generated `.env` files and secrets (invariant 8).
 * Returns a reason or undefined.
 */
export function forbiddenRead(relPath: string): string | undefined {
  // Compared case-insensitively: APFS and NTFS resolve `ENV/` to `env/`.
  const parts = relPath.toLowerCase().split(/[\\/]/);
  if (parts[0] === "env") return "env/ holds generated secrets and is never readable by agents";
  if (parts.some((p) => /^\.env(\..*)?$/.test(p) && p !== ".env.example")) {
    return ".env files are never readable by agents";
  }
  if (parts.some((p) => /\.(pem|key|p12|pfx|jks)$/.test(p))) return "key files are never readable by agents";
  if (parts.includes(".git")) return ".git internals are not readable by agents";
  return undefined;
}

const inside = (root: string, abs: string): string | undefined => {
  const rel = relative(root, abs);
  return rel.startsWith("..") || isAbsolute(rel) ? undefined : rel;
};

/**
 * Resolves a tool path inside the run folder. The real path (after symlinks) must also be inside
 * the run folder and readable, so a symlink committed in a PR cannot point at secrets.
 */
const confine = async (root: string, path: string): Promise<{ abs: string; rel: string }> => {
  const abs = resolve(root, path);
  const rel = inside(root, abs);
  if (rel === undefined) throw new Error("path is outside the run folder");
  const reason = forbiddenRead(rel);
  if (reason !== undefined) throw new Error(reason);
  let real: string;
  try {
    real = await realpath(abs);
  } catch {
    throw new Error(`${path} does not exist`);
  }
  const realRel = inside(await realpath(root), real);
  if (realRel === undefined) throw new Error("path resolves outside the run folder (symlink)");
  const realReason = forbiddenRead(realRel);
  if (realReason !== undefined)
    throw new Error(`path resolves to a forbidden location (symlink): ${realReason}`);
  // The lexical path is returned for display and walking; its real target was checked above.
  return { abs, rel: rel.split(sep).join("/") };
};

async function* walk(root: string, dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      yield* walk(root, join(dir, entry.name));
    } else if (entry.isFile()) {
      const rel = relative(root, join(dir, entry.name)).split(sep).join("/");
      if (forbiddenRead(rel) === undefined) yield rel;
    }
  }
}

/**
 * Read-only tools over the run folder (REQ-CTX-05/AC1): `read_file`, `list_files`, `search_code`.
 * Every output passes through `mask` before the model sees it.
 *
 * @param options - Run folder and masker.
 */
export function createReadOnlyTools(options: {
  readonly root: string;
  readonly mask: (text: string) => string;
}): AgentTool[] {
  const { root, mask } = options;
  return [
    {
      name: "read_file",
      description: `Read a text file in the run folder (e.g. repos/<repo>/src/x.ts). Returns up to ${String(READ_FILE_MAX_LINES)} numbered lines from 'from_line'.`,
      inputSchema: z.object({ path: z.string(), from_line: z.number().int().positive().optional() }),
      async execute(input) {
        const { abs } = await confine(root, String(input["path"]));
        const lines = (await readFile(abs, "utf8")).split("\n");
        const from = typeof input["from_line"] === "number" ? input["from_line"] : 1;
        const slice = lines.slice(from - 1, from - 1 + READ_FILE_MAX_LINES);
        const more =
          from - 1 + READ_FILE_MAX_LINES < lines.length
            ? `\n… ${String(lines.length)} lines total; continue with from_line`
            : "";
        return mask(slice.map((l, i) => `${String(from + i)}: ${l}`).join("\n") + more);
      },
    },
    {
      name: "list_files",
      description: "List files under a folder of the run folder, recursively (max 300 entries).",
      inputSchema: z.object({ path: z.string() }),
      async execute(input) {
        const { abs } = await confine(root, String(input["path"]));
        if (!(await stat(abs)).isDirectory()) return `${String(input["path"])} is not a folder`;
        const out: string[] = [];
        for await (const file of walk(root, abs)) {
          out.push(file);
          if (out.length >= 300) {
            out.push("… truncated");
            break;
          }
        }
        return mask(out.join("\n"));
      },
    },
    {
      name: "search_code",
      description: `Search text (case-insensitive, literal) in files under a folder of the run folder. Returns up to ${String(SEARCH_MAX_MATCHES)} 'path:line: text' matches.`,
      inputSchema: z.object({ query: z.string().min(2), path: z.string().optional() }),
      async execute(input) {
        const { abs } = await confine(root, typeof input["path"] === "string" ? input["path"] : "repos");
        const needle = String(input["query"]).toLowerCase();
        const matches: string[] = [];
        for await (const file of walk(root, abs)) {
          const info = await stat(join(root, file));
          if (info.size > 1_000_000) continue;
          const text = await readFile(join(root, file), "utf8");
          if (text.includes("\u0000")) continue;
          text.split("\n").forEach((line, i) => {
            if (matches.length < SEARCH_MAX_MATCHES && line.toLowerCase().includes(needle)) {
              matches.push(`${file}:${String(i + 1)}: ${line.trim().slice(0, 200)}`);
            }
          });
          if (matches.length >= SEARCH_MAX_MATCHES) break;
        }
        return mask(
          matches.length > 0
            ? matches.join("\n")
            : `no matches for '${String(input["query"])}' in ${basename(abs)}`,
        );
      },
    },
  ];
}
