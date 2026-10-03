import { AdapterError, type ResolvedEnvironment } from "@qajitsu/core";

const allowed = (env: ResolvedEnvironment, url: URL): void => {
  if (url.origin !== env.origin) {
    throw new AdapterError("ENV_URL_NOT_ALLOWED", `${url.origin} is not the environment origin.`, {
      origin: url.origin,
    });
  }
};

const call = async (
  env: ResolvedEnvironment,
  fetch: typeof globalThis.fetch,
  path: string,
  init: RequestInit = {},
  timeoutMs = 10_000,
): Promise<Response> => {
  const url = new URL(path, env.baseUrl);
  allowed(env, url);
  return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
};

/**
 * Health check before tests (REQ-ENV-01/AC1). An unreachable environment makes every case BLOCKED.
 *
 * @returns Whether the environment answered 2xx on the health path, with a reason.
 */
export async function checkHealth(
  env: ResolvedEnvironment,
  fetch: typeof globalThis.fetch,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const res = await call(env, fetch, env.profile.health_path);
    return res.ok
      ? { ok: true, detail: `HTTP ${String(res.status)}` }
      : { ok: false, detail: `health check answered HTTP ${String(res.status)}` };
  } catch (error) {
    return {
      ok: false,
      detail: `environment unreachable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Reads the deployed commit SHA from the version endpoint (REQ-ENV-02/AC1).
 *
 * @returns The SHA, or undefined when the environment does not report one.
 */
export async function readDeployedSha(
  env: ResolvedEnvironment,
  fetch: typeof globalThis.fetch,
): Promise<string | undefined> {
  if (env.versionPath === undefined) return undefined;
  try {
    const res = await call(env, fetch, env.versionPath);
    if (!res.ok) return undefined;
    const body = (await res.json()) as Record<string, unknown>;
    const value = body[env.profile.version_field];
    return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Compares the deployed SHA with the analysed SHAs (REQ-ENV-02/AC1). A short SHA matches its prefix.
 *
 * @returns `match`, `mismatch` or `unknown` (no version reported).
 */
export function compareDeployedSha(
  deployed: string | undefined,
  analysed: readonly string[],
): "match" | "mismatch" | "unknown" {
  if (deployed === undefined) return "unknown";
  return analysed.some((sha) => sha.startsWith(deployed) || deployed.startsWith(sha)) ? "match" : "mismatch";
}

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
      value,
    );

const fill = (value: unknown, vars: Record<string, string>): unknown => {
  if (typeof value === "string")
    return value.replace(/\{\{(username|password)\}\}/g, (_, k: string) => vars[k] ?? "");
  if (Array.isArray(value)) return value.map((v) => fill(v, vars));
  if (value !== null && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, vars)]));
  return value;
};

/**
 * Logs in every account alias of the environment with the framework helper (REQ-CFG-07/AC2).
 * Passwords and tokens are resolved and registered with the masker here; they never reach a model.
 *
 * @param env - Resolved environment.
 * @param deps - Fetch, secret resolver and masker registration.
 * @returns Request headers per alias and every secret value the runner must mask.
 * @throws {AdapterError} `ENV_LOGIN_FAILED` naming the alias, never the credentials.
 */
export async function loginAccounts(
  env: ResolvedEnvironment,
  deps: {
    readonly fetch: typeof globalThis.fetch;
    readonly resolveSecret: (reference: string) => Promise<string>;
    readonly registerSecret: (value: string) => void;
  },
): Promise<{
  accounts: Record<string, Record<string, string>>;
  secrets: string[];
  sessions: Record<string, string>;
}> {
  const accounts: Record<string, Record<string, string>> = {};
  const sessions: Record<string, string> = {};
  const secrets: string[] = [];
  const login = env.profile.login;
  for (const [alias, account] of Object.entries(env.profile.accounts)) {
    const username = account.username.startsWith("secret://")
      ? await deps.resolveSecret(account.username)
      : account.username;
    const password = await deps.resolveSecret(account.password);
    secrets.push(password);
    if (!login)
      throw new AdapterError(
        "ENV_LOGIN_MISSING",
        "Accounts need a login definition in the environment profile.",
        { alias },
      );
    let res: Response;
    try {
      res = await call(env, deps.fetch, login.path, {
        method: login.method,
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          ...(fill(login.body, { username, password }) as Record<string, unknown>),
          ...account.login_extra,
        }),
      });
    } catch (error) {
      throw new AdapterError(
        "ENV_LOGIN_FAILED",
        `Login of ${alias} failed: ${error instanceof Error ? error.message : "error"}.`,
        { alias },
      );
    }
    if (!res.ok)
      throw new AdapterError("ENV_LOGIN_FAILED", `Login of ${alias} answered HTTP ${String(res.status)}.`, {
        alias,
        status: res.status,
      });
    const token = at(await res.json(), login.token_path);
    if (typeof token !== "string" || token === "")
      throw new AdapterError("ENV_LOGIN_FAILED", `Login of ${alias} returned no token.`, { alias });
    deps.registerSecret(token);
    secrets.push(token);
    accounts[alias] = { [login.header.toLowerCase()]: login.scheme ? `${login.scheme} ${token}` : token };
    sessions[alias] = token;
  }
  return { accounts, secrets, sessions };
}
