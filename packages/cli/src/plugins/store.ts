import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "@qajitsu/toolchain";
import { z } from "zod";

/** Where plugins are installed: `<QAJitsu home>/plugins` (REQ-GEN-11/AC3). */
export const pluginsRoot = (qjHome: string): string => join(qjHome, "plugins");

/** One installed plugin, as recorded in `<plugins>/installed.json`. */
export const InstalledPluginSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  package: z.string().min(1),
  version: z.string().min(1),
  /** `registry`: the pinned version from the npm registry; `file`: a tarball given by path. */
  source: z.enum(["registry", "file"]),
  /** Subresource integrity of the tarball (`sha512-...`), checked before installing. */
  integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+=*$/),
  /** The tarball's path for `file`, its registry URL for `registry`. */
  from: z.string().min(1),
  installed_at: z.string(),
  path: z.string().min(1),
  /** Other plugins it needs (its `@qajitsu/adapter-*` peer dependencies), by package name. */
  requires: z.array(z.string().min(1)).default([]),
});

/** One installed plugin. */
export type InstalledPlugin = z.infer<typeof InstalledPluginSchema>;

const RecordSchema = z.strictObject({ schema: z.literal(1), plugins: z.array(InstalledPluginSchema) });

/** The installed plugins; none when nothing was installed yet. */
export async function readInstalledPlugins(root: string): Promise<InstalledPlugin[]> {
  const text = await readFile(join(root, "installed.json"), "utf8").catch(() => undefined);
  return text === undefined ? [] : RecordSchema.parse(JSON.parse(text) as unknown).plugins;
}

/** Replaces the record of installed plugins (atomically). */
export async function writeInstalledPlugins(
  root: string,
  plugins: readonly InstalledPlugin[],
): Promise<void> {
  await writeJsonAtomic(join(root, "installed.json"), { schema: 1, plugins });
}

/** One line of `<plugins>/history.jsonl`: every install and removal is recorded (REQ-GEN-11/AC10). */
export interface PluginHistoryEntry {
  readonly at: string;
  readonly action: "add" | "remove";
  readonly id: string;
  readonly version: string;
  readonly source?: string;
  readonly integrity?: string;
}

/** Appends one entry to the plugin history. */
export async function appendPluginHistory(root: string, entry: PluginHistoryEntry): Promise<void> {
  await mkdir(root, { recursive: true });
  await appendFile(join(root, "history.jsonl"), `${JSON.stringify(entry)}\n`, { mode: 0o644 });
}
