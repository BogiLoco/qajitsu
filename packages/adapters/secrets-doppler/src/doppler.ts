import { AdapterError, ConfigError, parseSecretRef, type SecretProvider } from "@qajitsu/core";

const NAME = /^[A-Z_][A-Z0-9_]*$/;

/** Options of the Doppler provider. */
export interface DopplerOptions {
  /** A Doppler service token, resolved from the `env` provider. */
  readonly token: () => Promise<string>;
  readonly project: string;
  readonly config: string;
  readonly fetch: typeof globalThis.fetch;
  /** API base URL, default `https://api.doppler.com`. */
  readonly baseUrl?: string;
}

/**
 * Creates the `doppler` secret provider (REQ-CFG-03/AC3): `secret://doppler/<NAME>` reads one secret of the
 * configured project and config. The config is downloaded once per resolver; values and the token never appear in
 * errors.
 *
 * @param options - Token source, project, config and HTTP client.
 * @example
 * const doppler = createDopplerSecretProvider({ token, project: "shop", config: "ci", fetch });
 * await doppler.resolve("secret://doppler/JIRA_TOKEN");
 */
export function createDopplerSecretProvider(options: DopplerOptions): SecretProvider {
  const base = (options.baseUrl ?? "https://api.doppler.com").replace(/\/+$/, "");
  let secrets: Promise<Readonly<Record<string, unknown>>> | undefined;
  const download = async (signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> => {
    const url = new URL(`${base}/v3/configs/config/secrets/download`);
    url.searchParams.set("project", options.project);
    url.searchParams.set("config", options.config);
    url.searchParams.set("format", "json");
    const res = await options.fetch(url, {
      headers: { authorization: `Bearer ${await options.token()}`, accept: "application/json" },
      ...(signal ? { signal } : {}),
    });
    if (!res.ok)
      throw new AdapterError("SECRET_SOURCE_UNREADABLE", `Doppler answered HTTP ${String(res.status)}.`, {
        provider: "doppler",
        status: res.status,
      });
    const body = await res.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  };
  return {
    scheme: "doppler",
    async resolve(reference, signal) {
      signal?.throwIfAborted();
      const { path: name } = parseSecretRef(reference);
      if (!NAME.test(name))
        throw new ConfigError("SECRET_REF_INVALID", "Doppler references look like secret://doppler/<NAME>.", {
          provider: "doppler",
        });
      secrets ??= download(signal);
      secrets.catch(() => {
        secrets = undefined;
      });
      const value = (await secrets)[name];
      if (typeof value !== "string")
        throw new AdapterError(
          "SECRET_NOT_FOUND",
          `Doppler has no secret ${name} in ${options.project}/${options.config}.`,
          {
            provider: "doppler",
          },
        );
      return value;
    },
  };
}
