import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConfigError } from "@qajitsu/core";
import { z } from "zod";
import { TOOL_IDS, type ToolId } from "./manifest.js";

/** One tool version QAJitsu installed (REQ-GEN-06/AC3). */
export const InstalledToolSchema = z.strictObject({
  tool: z.enum(TOOL_IDS),
  version: z.string().min(1),
  /** Absolute path: JAVA_HOME, the SDK root, the Appium prefix, a browser folder, or the system location. */
  path: z.string().min(1),
  /** Where it came from: a URL, `npm:<pkg>@<version>`, `sdkmanager`, `brew`, `bundle:<dir>`. */
  source: z.string().min(1),
  /** Checksum the download was verified against, `<algorithm>:<hex>`. */
  checksum: z.string().optional(),
  licence: z.string().min(1),
  installed_at: z.string(),
  /** Android SDK packages, browsers or folders that belong to this entry. */
  parts: z.array(z.string()).default([]),
  /** The smoke test passed (AC8); a tool that did not pass is never reported ready. */
  verified: z.boolean(),
  /** Docker and Xcode are system-wide: never removed by QAJitsu (AC3). */
  system: z.boolean().default(false),
});

/** An entry of the record. */
export type InstalledTool = z.infer<typeof InstalledToolSchema>;

/** `~/.qajitsu/toolchain/installed.json`. */
export const ToolchainRecordSchema = z.strictObject({
  schema: z.literal(1),
  tools: z.array(InstalledToolSchema),
});

/** The record of what QAJitsu installed. */
export type ToolchainRecord = z.infer<typeof ToolchainRecordSchema>;

/** The toolchain folder of a QAJitsu home. */
export const toolchainRoot = (qjHome: string): string => join(qjHome, "toolchain");

/** Where one managed tool version lives: `<root>/<tool>/<version>` (one copy per version, AC3). */
export const toolDir = (root: string, tool: ToolId, version: string): string =>
  join(root, tool, version.replace(/[^\w.+-]/g, "_"));

const recordFile = (root: string): string => join(root, "installed.json");

/** Writes JSON through a temporary file and a rename, so a reader never sees half a file. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o644 });
  await rename(tmp, file);
}

/**
 * Reads the record; a missing file is an empty record.
 *
 * @throws {ConfigError} `TOOLCHAIN_RECORD_INVALID` when the file is not a valid record: QAJitsu then refuses to
 * change or remove anything rather than guess what it installed.
 */
export async function readToolchainRecord(root: string): Promise<ToolchainRecord> {
  const text = await readFile(recordFile(root), "utf8").catch(() => undefined);
  if (text === undefined) return { schema: 1, tools: [] };
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const parsed = ToolchainRecordSchema.safeParse(json);
  if (!parsed.success)
    throw new ConfigError(
      "TOOLCHAIN_RECORD_INVALID",
      `${recordFile(root)} is not a valid toolchain record; nothing is changed. Move it away and run qj setup again.`,
      { file: recordFile(root) },
    );
  return parsed.data;
}

/** Adds or replaces the entry of one tool version. */
export async function recordInstalled(root: string, entry: InstalledTool): Promise<ToolchainRecord> {
  const current = await readToolchainRecord(root);
  const next: ToolchainRecord = {
    schema: 1,
    tools: [...current.tools.filter((t) => !(t.tool === entry.tool && t.version === entry.version)), entry],
  };
  await writeJsonAtomic(recordFile(root), next);
  return next;
}

/** Removes entries from the record. */
export async function forgetInstalled(
  root: string,
  keep: (entry: InstalledTool) => boolean,
): Promise<ToolchainRecord> {
  const current = await readToolchainRecord(root);
  const next: ToolchainRecord = { schema: 1, tools: current.tools.filter(keep) };
  await writeJsonAtomic(recordFile(root), next);
  return next;
}

/** Which installation of each tool a project uses, written by `qj setup` (REQ-GEN-06/AC2+AC3). */
export const ToolchainChoiceSchema = z.strictObject({
  schema: z.literal(1),
  updated_at: z.string(),
  tools: z.partialRecord(
    z.enum(TOOL_IDS),
    z.strictObject({
      /** `system`: the user's own compatible tool, as it is. `managed`: the copy QAJitsu installed. */
      use: z.enum(["system", "managed"]),
      version: z.string().optional(),
      path: z.string().optional(),
    }),
  ),
});

/** A project's toolchain choice. */
export type ToolchainChoice = z.infer<typeof ToolchainChoiceSchema>;

/** `projects/<slug>/toolchain.json`. */
export const choiceFile = (projectHome: string): string => join(projectHome, "toolchain.json");

/** Reads a project's choice; missing or unreadable means "nothing chosen", so the user's own tools are used. */
export async function readToolchainChoice(projectHome: string): Promise<ToolchainChoice | undefined> {
  const text = await readFile(choiceFile(projectHome), "utf8").catch(() => undefined);
  if (text === undefined) return undefined;
  try {
    const parsed = ToolchainChoiceSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined;
  }
}
