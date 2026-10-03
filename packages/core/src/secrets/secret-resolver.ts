import { ConfigError } from "../errors.js";
import type { SecretProvider } from "../interfaces/secret-provider.js";

const SECRET_REF = /^secret:\/\/([a-z0-9-]+)\/(.+)$/;

/**
 * Splits a `secret://<provider>/<path>` reference (REQ-CFG-03/AC1).
 *
 * @param reference - The reference from configuration.
 * @returns Provider scheme and provider-specific path.
 * @throws {ConfigError} `SECRET_REF_INVALID` for anything that is not a secret reference.
 */
export function parseSecretRef(reference: string): { readonly provider: string; readonly path: string } {
  const match = SECRET_REF.exec(reference);
  if (!match?.[1] || !match[2]) {
    // The value may itself be a secret pasted by mistake, so it is never echoed.
    throw new ConfigError("SECRET_REF_INVALID", "Expected a secret:// reference.", {});
  }
  return { provider: match[1], path: match[2] };
}

/**
 * Creates the resolver used by every adapter (`AdapterDeps.resolveSecret`). Each resolved value is
 * handed to `onResolved`, which registers it with the masker before the value is used (invariant 8).
 *
 * @param providers - Available secret providers, keyed by their `scheme`.
 * @param onResolved - Called with every resolved value, e.g. `masker.register`.
 * @example
 * const resolveSecret = createSecretResolver([createEnvSecretProvider(...)], masker.register);
 * const token = await resolveSecret("secret://env/GITHUB_TOKEN");
 */
export function createSecretResolver(
  providers: readonly SecretProvider[],
  onResolved: (value: string) => void,
): (reference: string, signal?: AbortSignal) => Promise<string> {
  const byScheme = new Map(providers.map((p) => [p.scheme, p]));
  return async (reference, signal) => {
    const { provider } = parseSecretRef(reference);
    const source = byScheme.get(provider);
    if (!source) {
      throw new ConfigError("SECRET_PROVIDER_UNKNOWN", `No secret provider '${provider}' is configured.`, {
        provider,
        available: [...byScheme.keys()],
      });
    }
    const value = await source.resolve(reference, signal);
    onResolved(value);
    return value;
  };
}
