import { execFile } from "node:child_process";
import { resolve, sep } from "node:path";
import { z } from "zod";
import {
  AdapterError,
  accountMembers,
  type BrowserCookie,
  type BrowserState,
  type CredentialLookup,
  type EnvProvider,
  type ResolvedEnvironment,
} from "@qajitsu/core";

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
    /** The project's `.qa/` folder; login scripts are resolved under `.qa/auth/`. */
    readonly qaDir?: string;
    /** Runs a login script (replaced in tests); default: `execFile` with an argument array. */
    readonly runScript?: ScriptRunner;
  },
  /**
   * The pool member to log in per alias (REQ-ENV-09/AC2); only these aliases are logged in. Without it every alias
   * logs in with its first account.
   */
  select?: Readonly<Record<string, number>>,
): Promise<{
  accounts: Record<string, Record<string, string>>;
  secrets: string[];
  sessions: Record<string, string>;
  /** Cookies and storage per alias for the browser (REQ-EXEC-67/AC1). */
  browserStates: Record<string, BrowserState>;
  /** The logged-in accounts' secrets for `ui.fillSecret` (REQ-EXEC-67/AC3); never serialised. */
  credential: CredentialLookup;
}> {
  const accounts: Record<string, Record<string, string>> = {};
  const sessions: Record<string, string> = {};
  const browserStates: Record<string, BrowserState> = {};
  const credentials = new Map<string, { username: string; password: string }>();
  const secrets: string[] = [];
  const login = env.profile.login;
  const chosen = Object.entries(
    select ?? Object.fromEntries(Object.keys(env.profile.accounts).map((a) => [a, 0])),
  );
  for (const [alias, index] of chosen) {
    const entry = env.profile.accounts[alias];
    const account = entry ? accountMembers(entry).members[index] : undefined;
    if (!account)
      throw new AdapterError("ENV_ACCOUNT_UNKNOWN", `No account ${String(index + 1)} for ${alias}.`, {
        alias,
      });
    const username = account.username.startsWith("secret://")
      ? await deps.resolveSecret(account.username)
      : account.username;
    const password = await deps.resolveSecret(account.password);
    secrets.push(password);
    credentials.set(alias, { username, password });
    if (!login)
      throw new AdapterError(
        "ENV_LOGIN_MISSING",
        "Accounts need a login definition in the environment profile.",
        { alias },
      );
    if ("script" in login) {
      const result = await scriptLogin(login, alias, username, password, env, deps);
      const cookies = [...(result.cookies ?? []), ...(result.storage_state?.cookies ?? [])];
      const storage = Object.fromEntries(
        (result.storage_state?.origins ?? [])
          .filter((o) => o.origin === env.origin)
          .flatMap((o) => o.localStorage.map((e) => [e.name, e.value] as const)),
      );
      for (const value of [
        ...Object.values(result.headers),
        ...(result.session ? [result.session] : []),
        ...cookies.map((c) => c.value).filter((v) => v.length >= 6),
        ...Object.values(storage).filter((v) => v.length >= 6),
      ]) {
        deps.registerSecret(value);
        secrets.push(value);
      }
      accounts[alias] = Object.fromEntries(
        Object.entries(result.headers).map(([name, value]) => [name.toLowerCase(), value]),
      );
      if (cookies.length > 0 && accounts[alias]["cookie"] === undefined)
        accounts[alias] = { ...accounts[alias], cookie: cookieHeader(cookies) };
      if (result.session !== undefined) sessions[alias] = result.session;
      if (cookies.length > 0 || Object.keys(storage).length > 0)
        browserStates[alias] = {
          cookies,
          ...(Object.keys(storage).length > 0 ? { localStorage: storage } : {}),
        };
      continue;
    }
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
    // REQ-EXEC-67/AC2: the cookies the login sets are the session when no token path is configured.
    const cookies = parseSetCookie(res.headers.getSetCookie());
    for (const c of cookies.filter((c) => c.value.length >= 6)) {
      deps.registerSecret(c.value);
      secrets.push(c.value);
    }
    if (cookies.length > 0) browserStates[alias] = { cookies };
    if (login.token_path === undefined) {
      if (cookies.length === 0)
        throw new AdapterError("ENV_LOGIN_FAILED", `Login of ${alias} set no session cookie.`, { alias });
      accounts[alias] = { cookie: cookieHeader(cookies) };
      continue;
    }
    const token = at(await res.json(), login.token_path);
    if (typeof token !== "string" || token === "")
      throw new AdapterError("ENV_LOGIN_FAILED", `Login of ${alias} returned no token.`, { alias });
    deps.registerSecret(token);
    secrets.push(token);
    accounts[alias] = { [login.header.toLowerCase()]: login.scheme ? `${login.scheme} ${token}` : token };
    sessions[alias] = token;
  }
  return {
    accounts,
    secrets,
    sessions,
    browserStates,
    credential: (alias, field) => credentials.get(alias)?.[field],
  };
}

/** Runs a login script: command, arguments, environment and timeout; resolves with its stdout. */
export type ScriptRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly timeoutMs: number;
  },
) => Promise<string>;

const runWithExecFile: ScriptRunner = (command, args, options) =>
  new Promise((resolvePromise, reject) => {
    execFile(
      command,
      [...args],
      {
        env: { PATH: process.env["PATH"] ?? "", ...options.env },
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout) => {
        if (error) reject(new Error("login script failed"));
        else resolvePromise(stdout);
      },
    );
  });

const CookieSchema = z.object({
  name: z.string().min(1).max(200),
  value: z.string().max(8000),
  path: z.string().max(500).optional(),
  httpOnly: z.boolean().optional(),
  secure: z.boolean().optional(),
  sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
  expires: z.number().optional(),
});

/**
 * What a login script prints (REQ-GEN-01/AC2, REQ-EXEC-67/AC1): headers for the API client, and for the browser a
 * token (`session`), `cookies`, or a Playwright `storage_state` (its cookies and the application origin's
 * `localStorage`). Domains in it are ignored: the browser gets them for the application's origin only.
 */
const ScriptOutputSchema = z.strictObject({
  headers: z.record(z.string().regex(/^[A-Za-z0-9-]+$/), z.string().min(1)).default({}),
  session: z.string().min(1).optional(),
  cookies: z.array(CookieSchema).max(100).optional(),
  storage_state: z
    .object({
      cookies: z.array(CookieSchema).max(100).default([]),
      origins: z
        .array(
          z.object({
            origin: z.string(),
            localStorage: z.array(z.object({ name: z.string(), value: z.string() })).default([]),
          }),
        )
        .default([]),
    })
    .optional(),
});

/** Cookies of `Set-Cookie` headers (name, value, path, flags, expiry); attributes for other domains are dropped. */
export function parseSetCookie(headers: readonly string[], now: number = Date.now()): BrowserCookie[] {
  const out: BrowserCookie[] = [];
  for (const header of headers) {
    const [pair = "", ...attrs] = header.split(";").map((p) => p.trim());
    const eq = pair.indexOf("=");
    if (eq <= 0) continue;
    const cookie: { -readonly [K in keyof BrowserCookie]: BrowserCookie[K] } = {
      name: pair.slice(0, eq),
      value: pair.slice(eq + 1),
    };
    for (const attr of attrs) {
      const [k = "", v = ""] = attr.split("=").map((x) => x.trim());
      const key = k.toLowerCase();
      if (key === "path") cookie.path = v;
      else if (key === "httponly") cookie.httpOnly = true;
      else if (key === "secure") cookie.secure = true;
      else if (key === "samesite" && /^(strict|lax|none)$/i.test(v))
        cookie.sameSite = ((v[0]?.toUpperCase() ?? "") + v.slice(1).toLowerCase()) as
          "Strict" | "Lax" | "None";
      else if (key === "max-age" && /^-?\d+$/.test(v)) cookie.expires = Math.floor(now / 1000) + Number(v);
      else if (key === "expires" && cookie.expires === undefined) {
        const t = Date.parse(v);
        if (!Number.isNaN(t)) cookie.expires = Math.floor(t / 1000);
      }
    }
    out.push(cookie);
  }
  return out;
}

/** The `Cookie` header of a set of cookies, for the API client. */
const cookieHeader = (cookies: readonly BrowserCookie[]): string =>
  cookies.map((c) => `${c.name}=${c.value}`).join("; ");

/**
 * Logs one alias in with a script from `.qa/auth/` (REQ-GEN-01/AC2). The script's output and errors are
 * never repeated: they may hold the password or the session.
 *
 * @throws {AdapterError} `ENV_LOGIN_FAILED` naming the alias only.
 */
async function scriptLogin(
  login: { readonly script: string; readonly timeout_s: number },
  alias: string,
  username: string,
  password: string,
  env: ResolvedEnvironment,
  deps: { readonly qaDir?: string; readonly runScript?: ScriptRunner },
): Promise<z.infer<typeof ScriptOutputSchema>> {
  const failed = (why: string): AdapterError =>
    new AdapterError("ENV_LOGIN_FAILED", `Login script of ${alias} ${why}.`, { alias, script: login.script });
  if (deps.qaDir === undefined) throw failed("needs the project's .qa/ folder");
  const authDir = resolve(deps.qaDir, "auth");
  const file = resolve(deps.qaDir, login.script);
  if (!file.startsWith(`${authDir}${sep}`)) throw failed("is outside .qa/auth/");
  const [command, args] = /\.(mjs|cjs|js)$/.test(file) ? [process.execPath, [file]] : [file, []];
  let stdout: string;
  try {
    stdout = await (deps.runScript ?? runWithExecFile)(command, args, {
      cwd: deps.qaDir,
      timeoutMs: login.timeout_s * 1000,
      env: {
        BASE_URL: env.baseUrl,
        QAJITSU_ALIAS: alias,
        QAJITSU_USERNAME: username,
        QAJITSU_PASSWORD: password,
      },
    });
  } catch {
    throw failed("failed");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw failed("printed no JSON");
  }
  const result = ScriptOutputSchema.safeParse(parsed);
  if (!result.success) throw failed("printed an invalid session (expected { headers, session? })");
  return result.data;
}

/**
 * The provided environment as an EnvProvider (REQ-ENV-01, REQ-ENV-02, ADR-0005): `start` checks health and, when
 * healthy, reads the deployed SHA. It starts and stops nothing.
 *
 * @param env - The resolved environment (allowlist already applied).
 * @param fetch - HTTP client.
 * @param options - `readVersion: false` skips the deployed-SHA request (an environment this run built).
 * @example
 * const handle = await createRemoteEnvProvider(env, fetch).start();
 * if (!handle.health.ok) blockEveryCase(handle.health.detail);
 */
export function createRemoteEnvProvider(
  env: ResolvedEnvironment,
  fetch: typeof globalThis.fetch,
  options: { readonly readVersion?: boolean } = {},
): EnvProvider {
  return {
    kind: "remote",
    async start() {
      const health = await checkHealth(env, fetch);
      const deployedSha =
        health.ok && options.readVersion !== false ? await readDeployedSha(env, fetch) : undefined;
      return {
        baseUrl: env.baseUrl,
        health,
        deployedSha,
        stubs: [],
        stop: () => Promise.resolve({ logs: [] }),
      };
    },
  };
}
