import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rm, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { ConfigError } from "@qajitsu/core";
import { z } from "zod";
import { hashFile } from "./download.js";
import { swapInto } from "./installers.js";
import type { Host } from "./manifest.js";
import { InstalledToolSchema, readToolchainRecord, writeJsonAtomic, type InstalledTool } from "./registry.js";
import { isInside } from "./uninstall.js";

/** `bundle.json` of an offline bundle made by `qj setup --download <dir>` (REQ-GEN-06/AC7). */
export const BundleSchema = z.strictObject({
  schema: z.literal(1),
  host: z.strictObject({ os: z.enum(["darwin", "linux"]), arch: z.enum(["arm64", "x64"]) }),
  created_at: z.string(),
  /** Tools with paths relative to the bundle's `toolchain/` folder. */
  tools: z.array(InstalledToolSchema.extend({ folder: z.string() })),
  /** SHA-256 of each tool folder and browser folder (see {@link treeDigest}). */
  digests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/)),
  /** Browser folders under `ms-playwright/`. */
  browsers: z.array(z.string().regex(/^[\w.-]+$/)),
});

/** A parsed bundle manifest. */
export type Bundle = z.infer<typeof BundleSchema>;

/**
 * SHA-256 over a folder: every file's relative path, size and SHA-256, every symlink's target, in sorted order. A
 * changed, added or removed file changes it.
 */
export async function treeDigest(dir: string): Promise<string> {
  const lines: string[] = [];
  const walk = async (current: string): Promise<void> => {
    for (const name of (await readdir(current)).sort()) {
      const path = join(current, name);
      const rel = relative(dir, path);
      const info = await lstat(path);
      if (info.isSymbolicLink()) lines.push(`L ${rel} ${await readlink(path)}`);
      else if (info.isDirectory()) {
        lines.push(`D ${rel}`);
        await walk(path);
      } else lines.push(`F ${rel} ${String(info.size)} ${await hashFile(path, "sha256")}`);
    }
  };
  await walk(dir);
  return createHash("sha256").update(lines.join("\n")).digest("hex");
}

/** The folder of a bundled tool relative to the bundle's toolchain root: the version folder for Java. */
const folderIn = (root: string, entry: InstalledTool): string => {
  const rel = relative(root, entry.path);
  return entry.tool === "java" ? rel.split("/").slice(0, 2).join("/") : rel;
};

/**
 * Writes `bundle.json` after `qj setup --download <dir>` installed everything into `<dir>/toolchain` and
 * `<dir>/ms-playwright` (REQ-GEN-06/AC7): the tools QAJitsu installed and a digest of every folder.
 */
export async function writeBundleManifest(dir: string, host: Host, now: () => Date): Promise<Bundle> {
  const root = join(dir, "toolchain");
  const record = await readToolchainRecord(root);
  const digests: Record<string, string> = {};
  const tools: Bundle["tools"] = [];
  for (const entry of record.tools.filter((t) => !t.system && t.verified)) {
    if (entry.tool === "browsers") continue;
    const folder = folderIn(root, entry);
    digests[folder] ??= await treeDigest(join(root, folder));
    tools.push({ ...entry, path: relative(root, entry.path), folder });
  }
  const browsersDir = join(dir, "ms-playwright");
  const browsers = (await readdir(browsersDir).catch(() => [] as string[])).filter((b) => !b.startsWith("."));
  for (const b of browsers) digests[`ms-playwright/${b}`] = await treeDigest(join(browsersDir, b));
  const bundle: Bundle = { schema: 1, host, created_at: now().toISOString(), tools, digests, browsers };
  await writeJsonAtomic(join(dir, "bundle.json"), bundle);
  return bundle;
}

/**
 * Copies the tools of an offline bundle into the toolchain (REQ-GEN-06/AC7): the bundle must be for this operating
 * system and processor, and every folder must match its digest before it is used. Tools land at the same relative
 * place as in the bundle; browsers go to Playwright's cache unless already there. The returned entries are not yet
 * verified: the caller runs their smoke tests.
 *
 * @throws {ConfigError} `BUNDLE_INVALID`, `BUNDLE_HOST_MISMATCH` or `BUNDLE_DIGEST_MISMATCH`.
 */
export async function importBundle(
  dir: string,
  root: string,
  host: Host,
  browserCache: string,
  now: () => Date,
): Promise<{ tools: InstalledTool[]; browsers: string[] }> {
  let json: unknown;
  try {
    json = JSON.parse(await readFile(join(dir, "bundle.json"), "utf8"));
  } catch {
    json = undefined;
  }
  const parsed = BundleSchema.safeParse(json);
  if (!parsed.success)
    throw new ConfigError(
      "BUNDLE_INVALID",
      `${join(dir, "bundle.json")} is missing or not a QAJitsu bundle.`,
      { dir },
    );
  const bundle = parsed.data;
  if (bundle.host.os !== host.os || bundle.host.arch !== host.arch)
    throw new ConfigError(
      "BUNDLE_HOST_MISMATCH",
      `The bundle is for ${bundle.host.os} ${bundle.host.arch}, this machine is ${host.os} ${host.arch}; make one with qj setup --download on a machine like this one.`,
      {},
    );
  const source = join(dir, "toolchain");
  const verify = async (folder: string, key: string): Promise<void> => {
    if ((await treeDigest(folder)) !== bundle.digests[key])
      throw new ConfigError(
        "BUNDLE_DIGEST_MISMATCH",
        `${folder} does not match the bundle's digest; nothing of it was installed.`,
        {
          folder,
        },
      );
  };
  const tools: InstalledTool[] = [];
  const copied = new Set<string>();
  for (const { folder, ...entry } of bundle.tools) {
    const from = join(source, folder);
    const to = join(root, folder);
    if (!isInside(from, source) || !isInside(to, root))
      throw new ConfigError("BUNDLE_INVALID", `${folder} points outside the bundle.`, { folder });
    if (!copied.has(folder)) {
      await verify(from, folder);
      const staging = `${to}.tmp-bundle`;
      await rm(staging, { recursive: true, force: true });
      await mkdir(join(staging, ".."), { recursive: true });
      await cp(from, staging, { recursive: true, verbatimSymlinks: true });
      await swapInto(staging, to);
      // Appium's extension manifest is a cache holding absolute paths of the bundle; Appium rebuilds it from
      // node_modules on its next start, with this machine's paths.
      if (entry.tool === "uiautomator2" || entry.tool === "xcuitest")
        await rm(join(to, "node_modules", ".cache", "appium", "extensions.yaml"), { force: true });
      copied.add(folder);
    }
    tools.push({
      ...entry,
      path: join(root, entry.path),
      source: `bundle:${dir}`,
      installed_at: now().toISOString(),
      // AVDs hold absolute paths: they are created again on this machine.
      parts: entry.parts.filter((p) => !p.startsWith("avd:")),
      verified: false,
    });
  }
  const browsers: string[] = [];
  for (const b of bundle.browsers) {
    const from = join(dir, "ms-playwright", b);
    const to = join(browserCache, b);
    if (await stat(to).catch(() => undefined)) continue;
    await verify(from, `ms-playwright/${b}`);
    await mkdir(browserCache, { recursive: true });
    await cp(from, to, { recursive: true, verbatimSymlinks: true });
    browsers.push(b);
  }
  return { tools, browsers };
}
