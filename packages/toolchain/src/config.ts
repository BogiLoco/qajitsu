import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ConfigError } from "@qajitsu/core";
import { parse } from "yaml";
import { z } from "zod";

const SecretRef = z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Expected a secret:// reference");
const Exact = z.string().regex(/^\d+\.\d+\.\d+$/, "Expected an exact version like 3.8.0");

/**
 * `toolchain.yaml`, per machine (`~/.qajitsu/toolchain.yaml`) or per project (`.qa/toolchain.yaml`); the project's
 * values win key by key (REQ-GEN-06/AC1+AC7). It holds versions, sources and network settings, never a secret value.
 */
export const ToolchainFileSchema = z.strictObject({
  schema: z.literal(1).default(1),
  /** Versions other than QAJitsu's pins (REQ-GEN-06/AC1). */
  versions: z
    .strictObject({
      /** A Temurin major (`21`, the latest release of it) or QAJitsu's pinned release. */
      java: z
        .string()
        .regex(/^\d+(\.\d+)*(\+\d+)?$/)
        .optional(),
      android: z
        .strictObject({
          platform: z.number().int().min(21).max(99).optional(),
          build_tools: Exact.optional(),
        })
        .optional(),
      appium: Exact.optional(),
      uiautomator2: Exact.optional(),
      xcuitest: Exact.optional(),
      xcode: z
        .string()
        .regex(/^\d+(\.\d+)*$/)
        .optional(),
    })
    .default({}),
  /** Private mirrors (REQ-GEN-06/AC7). */
  sources: z
    .strictObject({
      npm_registry: z.url().optional(),
      /** Token of the npm registry, resolved by the secret provider and passed to npm through its environment. */
      npm_token: SecretRef.optional(),
      /** Replaces Playwright's browser download host (PLAYWRIGHT_DOWNLOAD_HOST). */
      playwright_host: z.url().optional(),
      /** Replaces https://github.com/adoptium in Temurin URLs; the published checksums still apply. */
      java_mirror: z.url().optional(),
      /** Replaces https://dl.google.com/android/repository, also for sdkmanager. */
      android_mirror: z.url().optional(),
      homebrew_bottle_domain: z.url().optional(),
      homebrew_api_domain: z.url().optional(),
    })
    .default({}),
  network: z
    .strictObject({
      /** HTTP(S) proxy for every download (curl, npm, Playwright, sdkmanager, Homebrew). */
      proxy: z.url().optional(),
      no_proxy: z.array(z.string().min(1)).default([]),
      /** PEM file with the company CA, trusted in addition to the public ones. */
      ca_certs: z.string().min(1).optional(),
    })
    .default({ no_proxy: [] }),
});

/** A parsed `toolchain.yaml`. */
export type ToolchainFile = z.infer<typeof ToolchainFileSchema>;

const EMPTY: ToolchainFile = ToolchainFileSchema.parse({});

async function readToolchainFile(file: string): Promise<ToolchainFile> {
  const text = await readFile(file, "utf8").catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  });
  if (text === undefined) return EMPTY;
  const parsed = ToolchainFileSchema.safeParse(parse(text) ?? {});
  if (!parsed.success)
    throw new ConfigError(
      "TOOLCHAIN_CONFIG_INVALID",
      `${file}: ${parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`,
      { file },
    );
  return parsed.data;
}

/**
 * The toolchain settings of a machine and a project: `~/.qajitsu/toolchain.yaml`, then `.qa/toolchain.yaml` on top.
 * Missing files are empty; a relative `ca_certs` is resolved against the folder of the file that sets it.
 *
 * @param qjHome - The QAJitsu home.
 * @param qaDir - The project's `.qa/` folder, when there is a project.
 * @throws {ConfigError} `TOOLCHAIN_CONFIG_INVALID` when a file does not match the schema.
 */
export async function loadToolchainConfig(qjHome: string, qaDir?: string): Promise<ToolchainFile> {
  const absolute = (file: ToolchainFile, dir: string): ToolchainFile =>
    file.network.ca_certs !== undefined && !file.network.ca_certs.startsWith("/")
      ? { ...file, network: { ...file.network, ca_certs: join(dir, file.network.ca_certs) } }
      : file;
  const machine = absolute(await readToolchainFile(join(qjHome, "toolchain.yaml")), qjHome);
  const project =
    qaDir === undefined ? EMPTY : absolute(await readToolchainFile(join(qaDir, "toolchain.yaml")), qaDir);
  return mergeToolchainConfig(machine, project);
}

/** The project's settings over the machine's, key by key. */
export function mergeToolchainConfig(machine: ToolchainFile, project: ToolchainFile): ToolchainFile {
  return {
    schema: 1,
    versions: {
      ...machine.versions,
      ...project.versions,
      ...(machine.versions.android || project.versions.android
        ? { android: { ...machine.versions.android, ...project.versions.android } }
        : {}),
    },
    sources: { ...machine.sources, ...project.sources },
    network: {
      ...machine.network,
      ...project.network,
      no_proxy: [...new Set([...machine.network.no_proxy, ...project.network.no_proxy])],
    },
  };
}
