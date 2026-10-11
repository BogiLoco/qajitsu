import { readFile, writeFile } from "node:fs/promises";
import { rootCertificates } from "node:tls";
import { join } from "node:path";
import type { ToolchainFile } from "./config.js";
import { ANDROID_BASE } from "./manifest.js";

/** Runs a command; `interactive` hands the terminal to it (licences, sudo, Apple ID) and captures nothing. */
export type RunExec = (
  cmd: string,
  args: readonly string[],
  options?: {
    readonly env?: Readonly<Record<string, string>>;
    readonly cwd?: string;
    /** Written to stdin, then stdin is closed. */
    readonly input?: string;
    readonly interactive?: boolean;
  },
) => Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }>;

/** Usage analytics of the tools QAJitsu starts are switched off (REQ-GEN-06/AC9). */
export const ANALYTICS_OFF: Readonly<Record<string, string>> = {
  HOMEBREW_NO_ANALYTICS: "1",
  DO_NOT_TRACK: "1",
};

/** How the installers reach the network: environment for every tool, curl arguments, sdkmanager arguments. */
export interface Network {
  readonly env: Readonly<Record<string, string>>;
  readonly curlArgs: readonly string[];
  readonly sdkmanagerArgs: readonly string[];
}

/**
 * Writes a CA bundle with the public roots Node.js trusts plus the company CA, for tools that replace their trust
 * store with a file (curl `--cacert`, npm `cafile`) rather than add to it (REQ-GEN-06/AC7).
 *
 * @returns The bundle's path.
 */
export async function writeCaBundle(caFile: string, root: string): Promise<string> {
  const company = await readFile(caFile, "utf8");
  const bundle = join(root, "ca-bundle.pem");
  await writeFile(bundle, `${rootCertificates.join("\n")}\n${company.trim()}\n`, { mode: 0o644 });
  return bundle;
}

/**
 * The network settings of the installers (REQ-GEN-06/AC7): mirrors (npm registry, Playwright host, Android
 * repository, Homebrew), a proxy and a company CA. The npm token is passed in the environment and referenced from a
 * user config file, so it is never written to disk or put on a command line.
 *
 * @param config - Toolchain settings.
 * @param extra - The CA bundle, the npm user config file and the resolved npm token.
 */
export function networkFor(
  config: ToolchainFile,
  extra: { readonly caBundle?: string; readonly npmrc?: string; readonly npmToken?: string } = {},
): Network {
  const env: Record<string, string> = { ...ANALYTICS_OFF, HOMEBREW_NO_ENV_HINTS: "1" };
  const { proxy, no_proxy: noProxy, ca_certs: caCerts } = config.network;
  const curlArgs: string[] = [];
  const sdkmanagerArgs: string[] = [];
  if (proxy !== undefined) {
    for (const key of ["HTTPS_PROXY", "HTTP_PROXY", "https_proxy", "http_proxy"]) env[key] = proxy;
    env["npm_config_proxy"] = proxy;
    env["npm_config_https_proxy"] = proxy;
    curlArgs.push("--proxy", proxy);
    const url = new URL(proxy);
    sdkmanagerArgs.push(
      `--proxy=http`,
      `--proxy_host=${url.hostname}`,
      `--proxy_port=${url.port || (url.protocol === "https:" ? "443" : "80")}`,
    );
  }
  if (noProxy.length > 0) {
    env["NO_PROXY"] = noProxy.join(",");
    env["no_proxy"] = noProxy.join(",");
    curlArgs.push("--noproxy", noProxy.join(","));
  }
  if (caCerts !== undefined) env["NODE_EXTRA_CA_CERTS"] = caCerts;
  if (extra.caBundle !== undefined) {
    env["npm_config_cafile"] = extra.caBundle;
    env["SSL_CERT_FILE"] = extra.caBundle;
    env["CURL_CA_BUNDLE"] = extra.caBundle;
    curlArgs.push("--cacert", extra.caBundle);
  }
  const { sources } = config;
  if (sources.npm_registry !== undefined) env["npm_config_registry"] = sources.npm_registry;
  if (extra.npmrc !== undefined) env["npm_config_userconfig"] = extra.npmrc;
  if (extra.npmToken !== undefined) env["QJ_NPM_TOKEN"] = extra.npmToken;
  if (sources.playwright_host !== undefined) env["PLAYWRIGHT_DOWNLOAD_HOST"] = sources.playwright_host;
  if (sources.android_mirror !== undefined)
    // sdkmanager reads its repository base from SDK_TEST_BASE_URL (used by Android mirrors).
    env["SDK_TEST_BASE_URL"] = `${sources.android_mirror.replace(/\/+$/, "")}/`;
  if (sources.homebrew_bottle_domain !== undefined)
    env["HOMEBREW_BOTTLE_DOMAIN"] = sources.homebrew_bottle_domain;
  if (sources.homebrew_api_domain !== undefined) env["HOMEBREW_API_DOMAIN"] = sources.homebrew_api_domain;
  return { env, curlArgs, sdkmanagerArgs };
}

/**
 * An npm user config for a private registry with a token: the token is `${QJ_NPM_TOKEN}`, expanded by npm from the
 * environment.
 *
 * @returns The file's path.
 */
export async function writeNpmrc(registry: string, root: string): Promise<string> {
  const url = new URL(registry);
  const file = join(root, "npmrc");
  const path = url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`;
  await writeFile(file, `registry=${registry}\n//${url.host}${path}:_authToken=\${QJ_NPM_TOKEN}\n`, {
    mode: 0o600,
  });
  return file;
}

/** The URLs `qj doctor --online` checks answer (REQ-GEN-06/AC7). */
export function sourceUrls(config: ToolchainFile): { name: string; url: string }[] {
  const s = config.sources;
  return [
    ...(s.npm_registry ? [{ name: "npm registry", url: s.npm_registry }] : []),
    ...(s.playwright_host ? [{ name: "Playwright download host", url: s.playwright_host }] : []),
    ...(s.java_mirror ? [{ name: "Java mirror", url: s.java_mirror }] : []),
    {
      name: "Android repository",
      url: `${(s.android_mirror ?? ANDROID_BASE).replace(/\/+$/, "")}/repository2-3.xml`,
    },
    ...(s.homebrew_bottle_domain ? [{ name: "Homebrew bottles", url: s.homebrew_bottle_domain }] : []),
    ...(s.homebrew_api_domain ? [{ name: "Homebrew API", url: s.homebrew_api_domain }] : []),
  ];
}
