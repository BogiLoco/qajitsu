import { access } from "node:fs/promises";
import { resolve } from "node:path";
import type { ProjectConfig } from "../config/project-config.js";
import { templateReferences } from "./templates.js";

/** One problem found by {@link checkBuildConfig}. */
export interface EnvProblem {
  /** `service.VARIABLE`, `build.seed`, ... */
  readonly where: string;
  readonly problem: string;
}

/** Variable names that must come from the secret provider, never from committed files (REQ-CFG-01/AC1). */
const SENSITIVE_NAME = /(PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_KEY|CREDENTIALS?)$/i;

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

/**
 * Validates the `--build` configuration without starting anything (REQ-CFG-04): the build section,
 * template references, secret references (each must resolve), stub mappings, the seed hook and,
 * when a worktree is given, the compose file.
 *
 * @param options - Configuration, `.qa/` folder, an optional worktree and a secret probe.
 * @returns Every problem found; empty when the configuration can start.
 */
export async function checkBuildConfig(options: {
  readonly config: ProjectConfig;
  readonly qaDir: string;
  readonly worktree?: string | undefined;
  readonly secretExists: (reference: string) => Promise<boolean>;
}): Promise<EnvProblem[]> {
  const { config, qaDir } = options;
  const problems: EnvProblem[] = [];
  const build = config.build;
  if (!build) return [{ where: "build", problem: "not configured in .qa/qa.project.yaml" }];
  // Unknown repo, base service and a missing compose_file are rejected when the config is parsed.
  const services = config.services;
  const names = new Set(Object.keys(services));
  if (
    build.compose_file &&
    options.worktree &&
    !(await exists(resolve(options.worktree, build.compose_file)))
  )
    problems.push({
      where: "build.compose_file",
      problem: `${build.compose_file} not found in the worktree`,
    });
  if (build.seed && !(await exists(resolve(qaDir, build.seed))))
    problems.push({ where: "build.seed", problem: `.qa/${build.seed} not found` });
  if (build.profile && !(await exists(resolve(qaDir, "envs", `${build.profile}.yaml`))))
    problems.push({ where: "build.profile", problem: `.qa/envs/${build.profile}.yaml not found` });

  for (const [name, service] of Object.entries(services)) {
    if (service.kind === "stub" && !(await exists(resolve(qaDir, service.mappings))))
      problems.push({ where: `${name}.mappings`, problem: `.qa/${service.mappings} not found` });
    const templates = service.kind === "process" ? service.command.map((c) => ["command", c] as const) : [];
    for (const [variable, spec] of Object.entries(service.env)) {
      const literal = typeof spec === "string" ? spec : "value" in spec ? spec.value : undefined;
      if (SENSITIVE_NAME.test(variable) && literal !== undefined && literal !== "")
        problems.push({
          where: `${name}.${variable}`,
          problem: "looks like a secret but is a committed value; use { secret: secret://... }",
        });
      if (typeof spec === "object" && "secret" in spec) {
        if (!(await options.secretExists(spec.secret).catch(() => false)))
          problems.push({
            where: `${name}.${variable}`,
            problem: `secret ${spec.secret} cannot be resolved`,
          });
      } else if (typeof spec === "object" && "template" in spec) {
        templates.push([variable, spec.template] as never);
      }
    }
    for (const [where, template] of templates) {
      for (const ref of templateReferences(template)) {
        if (ref === "port") {
          if (service.kind !== "process")
            problems.push({ where: `${name}.${where}`, problem: "{{port}} is only defined for processes" });
          continue;
        }
        const m = /^svc\.([a-z][a-z0-9_-]*)\.(host|port|url)$/.exec(ref);
        if (!m) problems.push({ where: `${name}.${where}`, problem: `unknown reference {{${ref}}}` });
        else if (!names.has(m[1] ?? ""))
          problems.push({ where: `${name}.${where}`, problem: `{{${ref}}} names an unknown service` });
      }
    }
  }
  return problems;
}
