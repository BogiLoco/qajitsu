/** Replacement for every masked value. */
export const MASK = "***";

/** Headers masked regardless of value (REQ-CFG-06). Compared case-insensitively. */
export const DEFAULT_SENSITIVE_HEADERS: readonly string[] = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
];

/** JSON keys masked regardless of value (REQ-CFG-06). Compared case-insensitively. */
export const DEFAULT_SENSITIVE_KEYS: readonly string[] = [
  "password",
  "passwd",
  "secret",
  "token",
  "access_token",
  "refresh_token",
  "api_key",
  "apikey",
  "client_secret",
];

/** Secrets shorter than this are not masked by value, to avoid masking common words. */
export const MIN_SECRET_LENGTH = 6;

/** Masks secrets in everything that becomes evidence, logs or a Jira comment (REQ-CFG-06, invariant 8). */
export interface Masker {
  /** Registers a resolved secret value so every later output masks it. */
  register(secret: string): void;
  maskText(text: string): string;
  maskHeaders(headers: Readonly<Record<string, string>>): Record<string, string>;
  maskJson(value: unknown): unknown;
  /** Returns true when text still contains a registered secret (used by the publish gate, REQ-VER-07). */
  containsSecret(text: string): boolean;
}

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Creates a masker.
 *
 * @param options - Initial secrets and optional extra sensitive header and key names.
 * @example
 * const masker = createMasker({ secrets: [jiraToken] });
 * evidence.write(masker.maskJson(responseBody));
 */
export function createMasker(
  options: {
    readonly secrets?: readonly string[];
    readonly sensitiveHeaders?: readonly string[];
    readonly sensitiveKeys?: readonly string[];
  } = {},
): Masker {
  const secrets = new Set<string>();
  const headers = new Set(
    [...DEFAULT_SENSITIVE_HEADERS, ...(options.sensitiveHeaders ?? [])].map((h) => h.toLowerCase()),
  );
  const keys = new Set(
    [...DEFAULT_SENSITIVE_KEYS, ...(options.sensitiveKeys ?? [])].map((k) => k.toLowerCase()),
  );
  let pattern: RegExp | undefined;

  const rebuild = (): void => {
    const sorted = [...secrets].sort((a, b) => b.length - a.length).map(escapeRegExp);
    pattern = sorted.length > 0 ? new RegExp(sorted.join("|"), "g") : undefined;
  };

  const register = (secret: string): void => {
    if (secret.length < MIN_SECRET_LENGTH || secrets.has(secret)) return;
    secrets.add(secret);
    rebuild();
  };

  for (const secret of options.secrets ?? []) register(secret);

  const maskText = (text: string): string => (pattern ? text.replace(pattern, MASK) : text);

  const maskJson = (value: unknown): unknown => {
    if (typeof value === "string") return maskText(value);
    if (Array.isArray(value)) return value.map(maskJson);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, inner]) => [
          key,
          keys.has(key.toLowerCase()) ? MASK : maskJson(inner),
        ]),
      );
    }
    return value;
  };

  return {
    register,
    maskText,
    maskJson,
    maskHeaders(input) {
      return Object.fromEntries(
        Object.entries(input).map(([name, value]) => [
          name,
          headers.has(name.toLowerCase()) ? MASK : maskText(value),
        ]),
      );
    },
    containsSecret(text) {
      if (!pattern) return false;
      pattern.lastIndex = 0;
      return pattern.test(text);
    },
  };
}
