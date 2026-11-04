import { GuardDeniedError } from "@qajitsu/core";

/** Whether a host matches a manifest host: the same name, or a subdomain of `*.domain`. */
function hostMatches(host: string, pattern: string): boolean {
  if (pattern.startsWith("*.")) {
    const domain = pattern.slice(2).toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  }
  return host === pattern.toLowerCase();
}

/**
 * The `fetch` an integration plugin gets (REQ-GEN-11/AC9, ADR-0015): a request goes out only to a host its manifest
 * names, or, when the manifest says `config`, to an origin the project configures for it (the Jira base URL, the
 * code host, the Vault address). Anything else is refused before it leaves, naming the plugin and the host.
 *
 * @param fetchImpl - The process's fetch.
 * @param options - The plugin, its manifest hosts and the URLs the project configures for it.
 */
export function guardedFetch(
  fetchImpl: typeof globalThis.fetch,
  options: {
    readonly plugin: string;
    readonly hosts: readonly string[];
    readonly configured?: readonly (string | undefined)[];
    /** Host patterns the project configures for it besides URLs (Jira's media hosts and their subdomains). */
    readonly configuredHosts?: readonly string[];
  },
): typeof globalThis.fetch {
  const origins = new Set(
    options.hosts.includes("config")
      ? (options.configured ?? []).flatMap((u) => {
          if (u === undefined) return [];
          try {
            return [new URL(u).origin];
          } catch {
            return [];
          }
        })
      : [],
  );
  const patterns = [
    ...options.hosts.filter((h) => h !== "config"),
    ...(options.hosts.includes("config") ? (options.configuredHosts ?? []) : []),
  ];
  return (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const host = url.hostname.toLowerCase();
    if (!origins.has(url.origin) && !patterns.some((p) => hostMatches(host, p)))
      return Promise.reject(
        new GuardDeniedError(
          "PLUGIN_HOST_DENIED",
          `${options.plugin} may not reach ${host}: its manifest names ${[...patterns, ...origins].join(", ") || "no host"}.`,
          { plugin: options.plugin, host },
        ),
      );
    return fetchImpl(input, init);
  };
}
