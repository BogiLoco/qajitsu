import { z } from "zod";

const SecretRef = z.string().regex(/^secret:\/\/[a-z0-9-]+\/.+$/, "Expected a secret:// reference");
const Name = z.string().regex(/^[a-z][a-z0-9_-]{0,39}$/, "Use a lowercase service name");
const RelPath = z.string().regex(/^(?!\/)(?!.*\.\.)[\w./-]+$/, "Relative path without ..");

/**
 * One variable of a service (REQ-CFG-02/AC1): a constant, a template such as
 * `postgres://{{svc.db.host}}:{{svc.db.port}}/shop`, or a secret reference.
 */
export const ServiceVariableSchema = z.union([
  z.string(),
  z.strictObject({ value: z.string(), overridable: z.boolean().default(false) }),
  z.strictObject({ template: z.string(), overridable: z.boolean().default(false) }),
  z.strictObject({ secret: SecretRef }),
]);

/** A service variable. */
export type ServiceVariable = z.infer<typeof ServiceVariableSchema>;

/** Readiness check with a timeout (REQ-ENV-04/AC1): exactly one of `http`, `port`, `log`. */
export const HealthCheckSchema = z
  .strictObject({
    http: z.string().startsWith("/").optional(),
    port: z.literal(true).optional(),
    /** Regular expression matched against the service log. */
    log: z.string().min(1).optional(),
    timeout_s: z.number().positive().max(900).default(60),
  })
  .refine(
    (h) => [h.http, h.port, h.log].filter((x) => x !== undefined).length === 1,
    "Set exactly one of http, port or log",
  );

const Common = {
  env: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), ServiceVariableSchema).default({}),
  health: HealthCheckSchema.optional(),
};

/** A service started for `--build` (REQ-ENV-03, REQ-ENV-05). */
export const ServiceSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("compose"),
    /** Service name in the project's compose file; defaults to the key. */
    compose_service: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/, "A compose service name (no leading '-')")
      .optional(),
    /** Container port published on a dynamic localhost port. */
    port: z.number().int().min(1).max(65535),
    ...Common,
  }),
  z.strictObject({
    kind: z.literal("process"),
    /** Command as an argument array; `{{port}}` is the dynamically assigned port (REQ-ENV-03/AC2). */
    command: z.array(z.string().min(1)).min(1),
    /** Working directory relative to the build repository. */
    cwd: RelPath.optional(),
    ...Common,
  }),
  z.strictObject({
    kind: z.literal("stub"),
    engine: z.enum(["wiremock", "mockoon"]),
    /** Mappings folder relative to `.qa/` (e.g. `stubs/payments`) (REQ-ENV-05/AC1). */
    mappings: RelPath,
    ...Common,
  }),
]);

/** A service definition. */
export type ServiceConfig = z.infer<typeof ServiceSchema>;

/** How `--build` starts the application (REQ-ENV-03, REQ-CTX-04/AC4). */
export const BuildSchema = z.strictObject({
  /** Repository alias whose worktree is the build context. */
  repo: Name,
  /** Compose file relative to the repository; needed when a service has `kind: compose`. */
  compose_file: RelPath.optional(),
  /** Service whose URL is the environment base URL. */
  base_service: Name,
  /** Environment profile whose accounts, login and web session are used with the built URL. */
  profile: Name.optional(),
  /** Seed hook relative to `.qa/` run after readiness, e.g. `hooks/seed.mjs` (REQ-ENV-04/AC2). */
  seed: RelPath.optional(),
});

/** Cleanup and retention (REQ-WS-03). */
export const CleanupSchema = z.strictObject({
  policy: z.enum(["on_success", "always", "never"]).default("on_success"),
  keep_last: z.number().int().min(1).max(1000).default(10),
  max_age_days: z.number().int().min(1).max(3650).default(30),
});

export { Name as ServiceNameSchema };
