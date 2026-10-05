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
  /** Dotted path of the token in the JSON response. */
  token_path: z.string().min(1),
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

const LoginSchema = z.union([HttpLoginSchema, ScriptLoginSchema]);

/** Schema of `.qa/envs/<profile>.yaml` (REQ-ENV-01). */
export const EnvProfileSchema = z.strictObject({
  base_url: z.url(),
  /** Marks a production environment; denied unless `environments.allow_production` is true (INV-10). */
  production: z.boolean().default(false),
  health_path: z.string().startsWith("/").default("/health"),
  version_path: z.string().startsWith("/").optional(),
  /** Field of the version response holding the deployed SHA. */
  version_field: z.string().default("sha"),
  /** Test accounts by alias (`user:standard`); credentials are `secret://` references or plain user names. */
  accounts: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]*:[a-z0-9_.-]+$/, "Use aliases like user:standard"),
      z.strictObject({
        username: SecretOrText,
        password: z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Passwords must be secret:// references"),
        /** Extra fields merged into the login body for this alias, e.g. `{ ttl_seconds: 0 }` for an expired session. */
        login_extra: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
      }),
    )
    .default({}),
  login: LoginSchema.optional(),
  /** Where the web app keeps the session token; the framework sets it for `ui.as(alias)` (REQ-CFG-07). */
  web_session: z
    .strictObject({ storage: z.enum(["sessionStorage", "localStorage"]), key: z.string().min(1) })
    .optional(),
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
