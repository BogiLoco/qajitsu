import { AdapterError, ConfigError, parseSecretRef, type SecretProvider } from "@qajitsu/core";

const PATH = /^[\w.-]+(\/[\w.-]+)*$/;
const FIELD = /^[\w.-]+$/;
const LOOPBACK = /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** Options of the Vault provider. */
export interface VaultOptions {
  /** `https://vault.example.com`; plain HTTP only on loopback (a dev server). */
  readonly address: string;
  /** KV v2 mount, default `secret`. */
  readonly mount?: string;
  /** Vault Enterprise namespace. */
  readonly namespace?: string;
  /** The Vault token, resolved from the `env` provider (never written in configuration). */
  readonly token: () => Promise<string>;
  readonly fetch: typeof globalThis.fetch;
}

/**
 * Creates the `vault` secret provider (REQ-CFG-03/AC3): `secret://vault/<path>#<field>` reads one field of a KV v2
 * secret. Each path is fetched once per resolver; values and the token never appear in errors.
 *
 * @param options - Address, mount, namespace, token source and HTTP client.
 * @throws {ConfigError} `SECRET_PROVIDER_INSECURE` for plain HTTP to a remote address.
 * @example
 * const vault = createVaultSecretProvider({ address, mount: "kv", token: () => resolveEnv("secret://env/VAULT_TOKEN"), fetch });
 * await vault.resolve("secret://vault/ci/qajitsu#JIRA_TOKEN");
 */
export function createVaultSecretProvider(options: VaultOptions): SecretProvider {
  const address = options.address.replace(/\/+$/, "");
  if (!address.startsWith("https://") && !LOOPBACK.test(address))
    throw new ConfigError(
      "SECRET_PROVIDER_INSECURE",
      "Vault must be reached over https (http only on loopback).",
      {
        provider: "vault",
      },
    );
  const mount = options.mount ?? "secret";
  const cache = new Map<string, Promise<Readonly<Record<string, unknown>>>>();
  const read = (path: string, signal?: AbortSignal): Promise<Readonly<Record<string, unknown>>> => {
    const cached = cache.get(path);
    if (cached) return cached;
    const pending = (async () => {
      const token = await options.token();
      const res = await options.fetch(`${address}/v1/${mount}/data/${path}`, {
        headers: {
          "x-vault-token": token,
          ...(options.namespace ? { "x-vault-namespace": options.namespace } : {}),
        },
        ...(signal ? { signal } : {}),
      });
      if (res.status === 404)
        throw new AdapterError("SECRET_NOT_FOUND", `Vault has no secret at ${mount}/${path}.`, {
          provider: "vault",
        });
      if (!res.ok)
        throw new AdapterError("SECRET_SOURCE_UNREADABLE", `Vault answered HTTP ${String(res.status)}.`, {
          provider: "vault",
          status: res.status,
        });
      const body = (await res.json()) as { data?: { data?: unknown } };
      const data = body.data?.data;
      return typeof data === "object" && data !== null ? (data as Record<string, unknown>) : {};
    })();
    cache.set(path, pending);
    pending.catch(() => cache.delete(path));
    return pending;
  };
  return {
    scheme: "vault",
    async resolve(reference, signal) {
      signal?.throwIfAborted();
      const { path: raw } = parseSecretRef(reference);
      const hash = raw.lastIndexOf("#");
      const path = hash > 0 ? raw.slice(0, hash) : "";
      const field = hash > 0 ? raw.slice(hash + 1) : "";
      if (!PATH.test(path) || path.split("/").includes("..") || !FIELD.test(field))
        throw new ConfigError(
          "SECRET_REF_INVALID",
          "Vault references look like secret://vault/<path>#<field>.",
          {
            provider: "vault",
          },
        );
      const value = (await read(path, signal))[field];
      if (typeof value !== "string")
        throw new AdapterError("SECRET_NOT_FOUND", `Vault secret ${path} has no field ${field}.`, {
          provider: "vault",
        });
      return value;
    },
  };
}
