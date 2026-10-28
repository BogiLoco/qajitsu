import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { z } from "zod";
import { ConfigError } from "../errors.js";
import type { ProjectConfig } from "./project-config.js";

const SecretOrText = z.string().min(1);

/** How the framework logs an account in (REQ-CFG-07/AC2); `{{username}}`/`{{password}}` are substituted. */
const HttpLoginSchema = z.strictObject({
  method: z.enum(["POST", "PUT"]).default("POST"),
  path: z.string().startsWith("/"),
  body: z.record(z.string(), z.unknown()),
  /**
   * Dotted path of the token in the JSON response. Without it the session is the cookies the login sets
   * (`Set-Cookie`, REQ-EXEC-67/AC2): sent as `Cookie` by the API client and loaded into the browser.
   */
  token_path: z.string().min(1).optional(),
  header: z.string().default("authorization"),
  scheme: z.string().default("Bearer"),
});

/**
 * A login helper from `.qa/auth/` for logins a single request cannot do (SSO, cookies, several steps;
 * REQ-GEN-01/AC2). The trusted parent runs it per alias with `BASE_URL`, `QAJITSU_ALIAS`,
 * `QAJITSU_USERNAME` and `QAJITSU_PASSWORD`; it prints `{ "headers": {...}, "session"?: "..." }`.
 */
const ScriptLoginSchema = z.strictObject({
  script: z
    .string()
    .regex(/^auth\/[\w.-]+(\/[\w.-]+)*$/, "Login scripts live in .qa/auth/")
    .refine((p) => !p.split("/").includes(".."), "Login scripts live in .qa/auth/"),
  timeout_s: z.number().int().min(1).max(300).default(30),
});

/** One action of a browser login; `value` may hold `{{username}}`, `{{password}}` or `{{totp}}`. */
const BrowserLoginStepSchema = z.union([
  z.strictObject({ fill: z.string().min(1).max(300), value: z.string().min(1).max(300) }),
  z.strictObject({ click: z.string().min(1).max(300) }),
  z.strictObject({ press: z.string().min(1).max(300), key: z.string().min(1).max(40) }),
  z.strictObject({ wait_for: z.string().min(1).max(300) }),
]);

/**
 * A login through the browser (REQ-EXEC-55/AC2): SSO pages of an identity provider (OIDC, SAML, Azure AD, Okta,
 * Keycloak) with redirects and pop-ups, run by QAJitsu with the account's secrets. Its cookies and storage become the
 * session; with `reuse` one login serves every case of a run. The provider's origins must be in the allowlist.
 */
const BrowserLoginSchema = z.strictObject({
  browser: z.strictObject({
    /** Path of the application that starts the login, e.g. `/login` or `/oauth2/authorization/okta`. */
    start: z.string().startsWith("/"),
    steps: z.array(BrowserLoginStepSchema).min(1).max(30),
    /** When the login is done: back on a path of the application, and/or an element shown. */
    done: z
      .strictObject({
        path: z.string().startsWith("/").optional(),
        selector: z.string().min(1).max(300).optional(),
      })
      .refine((d) => d.path !== undefined || d.selector !== undefined, "Name a path or a selector"),
    /** Origins of the identity provider the browser may visit during the login. */
    allow: z.array(z.url()).max(10).default([]),
    timeout_s: z.number().int().min(5).max(300).default(60),
    /** One login per account and run, shared by its cases (default), or a new one per attempt. */
    reuse: z.boolean().default(true),
  }),
});

/** A browser login as configured (REQ-EXEC-55/AC2). */
export type BrowserLoginFlow = z.infer<typeof BrowserLoginSchema>["browser"];

const LoginSchema = z.union([HttpLoginSchema, ScriptLoginSchema, BrowserLoginSchema]);

/** Lanes a run executes cases in (REQ-EXEC-19). */
export const LANES = ["api", "web", "mobile"] as const;

/** One lane of {@link LANES}. */
export type Lane = (typeof LANES)[number];

/** One test account. */
const AccountSchema = z.strictObject({
  username: SecretOrText,
  password: z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Passwords must be secret:// references"),
  /** Extra fields merged into the login body for this alias, e.g. `{ ttl_seconds: 0 }` for an expired session. */
  login_extra: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  /** Lanes that may use this account, e.g. `[mobile]` for an app that allows one session per user (REQ-ENV-09/AC3). */
  lanes: z.array(z.enum(LANES)).min(1).optional(),
  /**
   * The account's authenticator for two-factor logins (REQ-EXEC-55/AC1): the base32 seed as a `secret://` reference,
   * with the application's digits, period and algorithm. Codes are computed by QAJitsu at the moment they are typed.
   */
  totp: z
    .union([
      z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "TOTP seeds must be secret:// references"),
      z.strictObject({
        seed: z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "TOTP seeds must be secret:// references"),
        digits: z.number().int().min(6).max(8).default(6),
        period: z.number().int().min(15).max(120).default(30),
        algorithm: z.enum(["sha1", "sha256", "sha512"]).default("sha1"),
      }),
    ])
    .optional(),
});

/** A test account as configured. */
export type AccountConfig = z.infer<typeof AccountSchema>;

/**
 * An alias: one account, or a pool of accounts (REQ-ENV-09/AC1). `shared: true` lets cases running at the same time
 * use the same account (e.g. a read-only admin); otherwise each running case holds its account for itself.
 */
const AccountEntrySchema = z.union([
  AccountSchema.extend({ shared: z.boolean().default(false) }),
  z.strictObject({ pool: z.array(AccountSchema).min(1).max(200), shared: z.boolean().default(false) }),
]);

/** An alias entry of `accounts`. */
export type AccountEntry = z.infer<typeof AccountEntrySchema>;

/** The accounts of an alias, in order, and whether running cases may share them. */
export function accountMembers(entry: AccountEntry): { members: AccountConfig[]; shared: boolean } {
  if ("pool" in entry) return { members: entry.pool, shared: entry.shared };
  const { shared, ...account } = entry;
  return { members: [account], shared };
}

/** Schema of `.qa/envs/<profile>.yaml` (REQ-ENV-01). */
export const EnvProfileSchema = z.strictObject({
  base_url: z.url(),
  /** Marks a production environment; denied unless `environments.allow_production` is true (INV-10). */
  production: z.boolean().default(false),
  health_path: z.string().startsWith("/").default("/health"),
  version_path: z.string().startsWith("/").optional(),
  /** Field of the version response holding the deployed SHA. */
  version_field: z.string().default("sha"),
  /**
   * Test accounts by alias (`user:standard`); credentials are `secret://` references or plain user names. An alias is
   * one account or a pool of accounts handed out one per running case (REQ-ENV-09).
   */
  accounts: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]*:[a-z0-9_.-]+$/, "Use aliases like user:standard"),
      AccountEntrySchema,
    )
    .default({}),
  login: LoginSchema.optional(),
  /**
   * Where the web app keeps its session; the framework sets it for `ui.as(alias)` (REQ-CFG-07): a token in
   * `sessionStorage` or `localStorage` under `key`, or the login's cookies (REQ-EXEC-67/AC2).
   */
  web_session: z
    .union([
      z.strictObject({ storage: z.enum(["sessionStorage", "localStorage"]), key: z.string().min(1) }),
      z.strictObject({ storage: z.literal("cookies") }),
    ])
    .optional(),
  /**
   * HTTP authentication in front of the environment (REQ-EXEC-61/AC5), e.g. a staging site behind Basic Auth: sent by
   * the browser and the API client when the server asks for it.
   */
  http_auth: z
    .strictObject({
      username: z.string().min(1),
      password: z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Passwords must be secret:// references"),
    })
    .optional(),
  /**
   * Headers the application offers for tests, sent to its own origin only by the browser, the API client and the
   * browser login (REQ-EXEC-55/AC4), e.g. a captcha bypass: `{ X-Captcha-Bypass: secret://vault/staging#bypass }`.
   * QAJitsu never solves captchas; without such a mechanism the step stays manual.
   */
  test_headers: z
    .record(z.string().regex(/^[A-Za-z0-9-]{1,60}$/, "a header name"), z.string().min(1).max(2000))
    .default({}),
  /** Feature flags of this environment, available to plans and specs as data. */
  flags: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
});

/** A resolved environment for one run. */
export interface ResolvedEnvironment {
  readonly name: string;
  readonly baseUrl: string;
  readonly origin: string;
  readonly profile: z.infer<typeof EnvProfileSchema>;
  readonly versionPath?: string | undefined;
}

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,39}$/;

/**
 * Resolves `--env <profile|url>` or the default environment (REQ-ENV-01, REQ-ENV-07) and enforces the
 * allowlist and the production ban (REQ-ENV-01/AC2, invariant 10).
 *
 * @param options - Project config, `.qa/` folder and the `--env` value.
 * @throws {ConfigError} `ENV_NOT_SELECTED`, `ENV_PROFILE_INVALID`, `ENV_NOT_ALLOWED` or `ENV_PRODUCTION_DENIED`.
 */
export async function resolveEnvironment(options: {
  readonly config: ProjectConfig;
  readonly qaDir: string;
  readonly env?: string | undefined;
  /**
   * URL of an environment this run built on localhost (`--build`). The profile then provides
   * accounts, login and web session only; the URL needs no allowlist entry because it is a loopback
   * address the run itself started. The production ban of the profile still applies.
   */
  readonly buildBaseUrl?: string | undefined;
}): Promise<ResolvedEnvironment> {
  const { config, qaDir, buildBaseUrl } = options;
  if (buildBaseUrl !== undefined && !/^http:\/\/127\.0\.0\.1:\d+$/.test(buildBaseUrl)) {
    throw new ConfigError("ENV_NOT_ALLOWED", "A built environment must listen on 127.0.0.1.", {});
  }
  const selected =
    options.env ??
    (buildBaseUrl === undefined ? undefined : config.build?.profile) ??
    config.environments.default;
  if (selected === undefined && buildBaseUrl !== undefined) {
    return {
      name: "build",
      baseUrl: buildBaseUrl,
      origin: buildBaseUrl,
      profile: EnvProfileSchema.parse({ base_url: buildBaseUrl }),
    };
  }
  if (selected === undefined) {
    throw new ConfigError(
      "ENV_NOT_SELECTED",
      "No environment: pass --env <profile|url> or set environments.default.",
      {},
    );
  }
  const isUrl = /^https?:\/\//.test(selected);
  const profileName = isUrl ? config.environments.default : selected;
  let raw: unknown = undefined;
  if (profileName !== undefined) {
    if (!PROFILE_NAME.test(profileName))
      throw new ConfigError("ENV_PROFILE_INVALID", `Invalid environment profile name '${profileName}'.`, {});
    try {
      raw = parse(await readFile(join(qaDir, "envs", `${profileName}.yaml`), "utf8")) as unknown;
    } catch (error) {
      if (!isUrl || (error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new ConfigError("ENV_PROFILE_INVALID", `Cannot read .qa/envs/${profileName}.yaml.`, {
          profile: profileName,
        });
      }
    }
  }
  const parsed = EnvProfileSchema.safeParse({
    ...(raw as Record<string, unknown> | undefined),
    ...(isUrl ? { base_url: selected } : {}),
    // The production flag of the profile still applies: its accounts would log in to the built code.
    ...(buildBaseUrl === undefined ? {} : { base_url: buildBaseUrl }),
  });
  if (!parsed.success) {
    throw new ConfigError(
      "ENV_PROFILE_INVALID",
      `Invalid environment profile '${profileName ?? selected}'.`,
      {
        issues: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`),
      },
    );
  }
  const profile = parsed.data;
  const origin = new URL(profile.base_url).origin;
  const allowed = config.environments.allowlist.map((a) => new URL(a).origin);
  if (buildBaseUrl === undefined && !allowed.includes(origin)) {
    throw new ConfigError("ENV_NOT_ALLOWED", `${origin} is not in environments.allowlist.`, {
      origin,
      allowed,
    });
  }
  // REQ-EXEC-55/AC2 + INV-10: an SSO login visits only identity providers the project allows.
  const login = profile.login;
  for (const idp of login && "browser" in login ? login.browser.allow : []) {
    const idpOrigin = new URL(idp).origin;
    if (!allowed.includes(idpOrigin))
      throw new ConfigError(
        "ENV_NOT_ALLOWED",
        `The login's identity provider ${idpOrigin} is not in environments.allowlist.`,
        {
          origin: idpOrigin,
          allowed,
        },
      );
  }
  if (profile.production && !config.environments.allow_production) {
    throw new ConfigError(
      "ENV_PRODUCTION_DENIED",
      "Production environments are denied unless environments.allow_production is true.",
      { origin },
    );
  }
  return {
    name:
      buildBaseUrl !== undefined
        ? `build (${profileName ?? selected})`
        : isUrl
          ? selected
          : (profileName ?? selected),
    baseUrl: profile.base_url,
    origin,
    profile,
    versionPath: profile.version_path ?? config.environments.version_endpoint,
  };
}
