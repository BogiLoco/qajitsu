import { ConfigError } from "../errors.js";
import type { ServiceVariable } from "../config/services.js";

/** Where a service can be reached, as seen by the service that renders the template. */
export interface Endpoint {
  readonly host: string;
  readonly port: number;
}

/** Values a template can use (REQ-CFG-02/AC2). */
export interface TemplateContext {
  /** Endpoints of other services: `{{svc.<name>.host}}`, `{{svc.<name>.port}}`, `{{svc.<name>.url}}`. */
  readonly svc: Readonly<Record<string, Endpoint>>;
  /** The service's own assigned port: `{{port}}`. */
  readonly port?: number | undefined;
}

const TOKEN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

/**
 * Renders a template. Unknown references are configuration errors, never empty strings.
 *
 * @param template - Text with `{{svc.<name>.host|port|url}}` and `{{port}}`.
 * @param context - Endpoints and the own port.
 * @throws {ConfigError} `TEMPLATE_UNKNOWN_REFERENCE`.
 */
export function renderTemplate(template: string, context: TemplateContext): string {
  return template.replace(TOKEN, (_, ref: string) => {
    if (ref === "port" && context.port !== undefined) return String(context.port);
    const m = /^svc\.([a-z][a-z0-9_-]*)\.(host|port|url)$/.exec(ref);
    const target = m?.[1] ? context.svc[m[1]] : undefined;
    if (!m || !target)
      throw new ConfigError("TEMPLATE_UNKNOWN_REFERENCE", `Unknown template reference '{{${ref}}}'.`, {
        ref,
      });
    if (m[2] === "host") return target.host;
    if (m[2] === "port") return String(target.port);
    return `http://${target.host}:${String(target.port)}`;
  });
}

/** References used by a template, for validation without rendering (REQ-CFG-04). */
export function templateReferences(template: string): string[] {
  return [...template.matchAll(TOKEN)].map((m) => m[1] ?? "");
}

/**
 * Resolves the variables of a service (REQ-CFG-02). Run-level overrides apply only to variables marked
 * `overridable` (REQ-CFG-02/AC3).
 *
 * @returns The variables and the secret values among them (for masking).
 * @throws {ConfigError} `VARIABLE_NOT_OVERRIDABLE` for an override of a fixed variable.
 */
export async function resolveServiceEnv(
  env: Readonly<Record<string, ServiceVariable>>,
  context: TemplateContext,
  resolveSecret: (ref: string) => Promise<string>,
  overrides: Readonly<Record<string, string>> = {},
): Promise<{ vars: Record<string, string>; secrets: string[] }> {
  const vars: Record<string, string> = {};
  const secrets: string[] = [];
  for (const [name, spec] of Object.entries(env)) {
    const override = overrides[name];
    const overridable = typeof spec === "object" && "overridable" in spec && spec.overridable;
    if (override !== undefined && !overridable) {
      throw new ConfigError("VARIABLE_NOT_OVERRIDABLE", `${name} is not overridable.`, { name });
    }
    if (override !== undefined) vars[name] = override;
    else if (typeof spec === "string") vars[name] = spec;
    else if ("value" in spec) vars[name] = spec.value;
    else if ("template" in spec) vars[name] = renderTemplate(spec.template, context);
    else {
      const value = await resolveSecret(spec.secret);
      secrets.push(value);
      vars[name] = value;
    }
  }
  return { vars, secrets };
}

/**
 * Serialises variables as a `.env` file (quoted, newlines escaped).
 *
 * @param vars - Variables.
 */
export function toDotenv(vars: Readonly<Record<string, string>>): string {
  return Object.entries(vars)
    .map(([k, v]) => `${k}="${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`)
    .join("\n")
    .concat("\n");
}
