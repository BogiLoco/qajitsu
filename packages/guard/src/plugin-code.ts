import type { PluginPermission } from "@qajitsu/core";

/** One source or build file of a plugin. */
export interface PluginCodeFile {
  readonly path: string;
  readonly text: string;
}

/** A use in a plugin's code that its permissions do not cover; `never` for what no plugin may do. */
export interface PluginCodeViolation {
  readonly file: string;
  readonly line: number;
  readonly use: string;
  readonly needs: PluginPermission | "never";
}

/** Node's modules by the permission that covers them. */
const MODULES: Readonly<Record<string, PluginPermission>> = {
  net: "network",
  http: "network",
  https: "network",
  http2: "network",
  tls: "network",
  dgram: "network",
  dns: "network",
  "dns/promises": "network",
  child_process: "exec",
  worker_threads: "exec",
  cluster: "exec",
  fs: "filesystem",
  "fs/promises": "filesystem",
};

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["']([^"']+)["']/g;
const TYPE_ONLY = /^\s*(?:import|export)\s+type\b/;
const COMMENT = /^\s*(?:\/\/|\/?\*)/;

/** The permission a module specifier needs, or undefined when it is not one of Node's guarded modules. */
function moduleNeeds(specifier: string): PluginPermission | undefined {
  const name = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  return MODULES[name];
}

/**
 * Checks a plugin's own code against the permissions of its manifest (REQ-GEN-11/AC9, ADR-0015): Node's network,
 * process and file modules, reads of `process.env` and the global `fetch` must be declared, and no plugin may refer to
 * the frozen plan (invariant 3). Type-only imports and comment lines are not uses; the plugin's dependencies are not
 * scanned.
 *
 * @param files - The plugin's own files (its build output, or its sources in this repository).
 * @param permissions - The permissions of its manifest.
 * @returns Every use not covered, in file and line order; empty when the code keeps to its manifest.
 */
export function checkPluginCode(
  files: readonly PluginCodeFile[],
  permissions: readonly PluginPermission[],
): PluginCodeViolation[] {
  const allowed = new Set(permissions);
  const out: PluginCodeViolation[] = [];
  for (const f of files) {
    f.text.split(/\r?\n/).forEach((text, i) => {
      if (COMMENT.test(text)) return;
      const line = i + 1;
      const add = (use: string, needs: PluginPermission | "never"): void => {
        if (needs === "never" || !allowed.has(needs)) out.push({ file: f.path, line, use, needs });
      };
      if (!TYPE_ONLY.test(text))
        for (const m of text.matchAll(SPECIFIER)) {
          const spec = m[1] ?? "";
          const needs = moduleNeeds(spec);
          if (needs) add(spec.startsWith("node:") ? spec : `node:${spec}`, needs);
        }
      if (/\bprocess\.env\b/.test(text)) add("process.env", "environment");
      if (/\bglobalThis\.fetch\b/.test(text)) add("global fetch", "network");
      if (text.includes("plan.approved.yaml")) add("plan.approved.yaml", "never");
    });
  }
  return out;
}

/**
 * The violations as one sentence for a refusal (REQ-GEN-11/AC9), or undefined when there are none.
 *
 * @param violations - From {@link checkPluginCode}.
 */
export function pluginCodeProblems(violations: readonly PluginCodeViolation[]): string | undefined {
  if (violations.length === 0) return undefined;
  return violations
    .map((v) =>
      v.needs === "never"
        ? `${v.file}:${String(v.line)} refers to ${v.use}, which no plugin may`
        : `${v.file}:${String(v.line)} uses ${v.use} without the ${v.needs} permission`,
    )
    .join("; ");
}
