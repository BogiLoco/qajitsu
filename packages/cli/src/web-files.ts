import { readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { ConfigError } from "@qajitsu/core";
import { unzip } from "@qajitsu/report";

/** Largest fixture an upload may read (REQ-EXEC-38/AC1). */
const MAX_FIXTURE = 50_000_000;

/**
 * Reads a file of the project's `.qa/fixtures/` for an upload (REQ-EXEC-38/AC1): the path comes from the approved plan
 * and must stay inside that folder, symbolic links included.
 *
 * @throws {ConfigError} `FIXTURE_INVALID` for a path outside the folder, a missing file or one over 50 MB.
 */
export async function readFixture(qaDir: string, path: string): Promise<Uint8Array> {
  const dir = join(qaDir, "fixtures");
  const target = resolve(dir, path);
  const [realDir, realTarget] = await Promise.all([
    realpath(dir).catch(() => undefined),
    realpath(target).catch(() => undefined),
  ]);
  if (realDir === undefined || realTarget === undefined)
    throw new ConfigError("FIXTURE_INVALID", `No fixture ${path} in .qa/fixtures/.`, {});
  if (!realTarget.startsWith(`${realDir}${sep}`))
    throw new ConfigError("FIXTURE_INVALID", `The fixture ${path} is outside .qa/fixtures/.`, {});
  const info = await stat(realTarget);
  if (!info.isFile() || info.size > MAX_FIXTURE)
    throw new ConfigError("FIXTURE_INVALID", `The fixture ${path} is not a file of at most 50 MB.`, {});
  return new Uint8Array(await readFile(realTarget));
}

const decodeXml = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const csvCell = (v: string): string => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

/** The first sheet of an XLSX file as CSV text (shared and inline strings, numbers as written). */
function xlsxText(data: Uint8Array): string | undefined {
  // Limits against archives that unpack into far more than they hold.
  const files = new Map(
    unzip(data, { maxEntries: 5000, maxEntryBytes: 50_000_000, maxTotalBytes: 100_000_000 }).map((e) => [
      e.name,
      e.data,
    ]),
  );
  const text = (name: string): string | undefined => {
    const f = files.get(name);
    return f ? new TextDecoder().decode(f) : undefined;
  };
  const shared = [...(text("xl/sharedStrings.xml") ?? "").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    decodeXml([...(m[1] ?? "").matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1] ?? "").join("")),
  );
  const sheet = text("xl/worksheets/sheet1.xml");
  if (sheet === undefined) return undefined;
  const rows: string[] = [];
  for (const row of sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const c of (row[1] ?? "").matchAll(/<c([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1] ?? "";
      const body = c[2] ?? "";
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1];
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      const inline = /<is>[\s\S]*?<t[^>]*>([\s\S]*?)<\/t>/.exec(body)?.[1];
      cells.push(
        csvCell(
          type === "s"
            ? (shared[Number(value)] ?? "")
            : type === "inlineStr"
              ? decodeXml(inline ?? "")
              : decodeXml(value ?? ""),
        ),
      );
    }
    rows.push(cells.join(","));
  }
  return `${rows.join("\n")}\n`;
}

/**
 * Text of a downloaded PDF or XLSX file for `download.*` checks (REQ-EXEC-38/AC2), read by trusted code; undefined for
 * other types or unreadable content (the check then says so, never passes).
 */
export async function extractDownloadText(name: string, data: Uint8Array): Promise<string | undefined> {
  const ext = /\.([A-Za-z0-9]+)$/.exec(name)?.[1]?.toLowerCase();
  try {
    if (ext === "pdf") {
      const { extractText } = await import("unpdf");
      const { text } = await extractText(new Uint8Array(data), { mergePages: true });
      return text;
    }
    if (ext === "xlsx") return xlsxText(data);
  } catch {
    return undefined;
  }
  return undefined;
}
