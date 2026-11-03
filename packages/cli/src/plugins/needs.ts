import type { ProjectConfig } from "@qajitsu/core";

/** A plugin the project needs and the setting that needs it (REQ-GEN-11/AC2). */
export interface PluginNeed {
  readonly id: string;
  readonly setting: string;
}

/**
 * The official plugins a project's configuration needs (REQ-GEN-11/AC2, AC10), each with the setting that needs it,
 * so `qj doctor` can name what is missing and `qj plugin remove` what still uses a plugin. The API and web runners are
 * needed by every project; the knowledge store only when the project has a knowledge base.
 *
 * @param config - The project's configuration.
 * @param options - Whether the project has a knowledge base on disk, and its online knowledge sources.
 */
export function pluginNeeds(
  config: ProjectConfig,
  options: { readonly knowledge: boolean; readonly onlineSources?: readonly string[] },
): PluginNeed[] {
  const needs: PluginNeed[] = [];
  const need = (id: string, setting: string): void => {
    if (!needs.some((n) => n.id === id && n.setting === setting)) needs.push({ id, setting });
  };
  if (config.jira.type !== "file") {
    need("ticket-jira", `jira.type: ${config.jira.type}`);
    need("publish-jira", `jira.type: ${config.jira.type}`);
  }
  for (const [alias, host] of Object.entries(config.code_hosts))
    need(
      host.type === "local" ? "codehost-local" : `codehost-${host.type}`,
      `code_hosts.${alias}.type: ${host.type}`,
    );
  need("runner-api", "API cases");
  need("runner-web", "web cases");
  if (config.mobile !== undefined) need("runner-mobile", "mobile");
  if (config.build !== undefined || Object.values(config.services).some((s) => s.kind === "compose"))
    need("env-compose", config.build !== undefined ? "build" : "services (compose)");
  if (config.secrets.vault) need("secrets-vault", "secrets.vault");
  if (config.secrets.doppler) need("secrets-doppler", "secrets.doppler");
  for (const cli of ["op", "aws", "gcp"] as const)
    if (config.secrets[cli]) need("secrets-cli", `secrets.${cli}`);
  if (config.messages !== undefined)
    need("messages-webhooksite", `messages.provider: ${config.messages.provider}`);
  for (const [i, source] of config.test_cases.entries())
    if (source.type !== "file") need("testcases", `test_cases[${String(i)}].type: ${source.type}`);
  if (config.archive !== undefined) need("evidence-s3", `archive.type: ${config.archive.type}`);
  if (options.knowledge)
    need(`knowledge-${config.knowledge.store}`, `knowledge.store: ${config.knowledge.store}`);
  if (config.knowledge.confluence !== undefined) need("knowledge-confluence", "knowledge.confluence");
  // Knowledge sources added from online systems (`confluence:SHOP`, `jira:payments`) need their plugin too.
  for (const source of options.onlineSources ?? []) {
    if (source.startsWith("confluence:")) need("knowledge-confluence", `knowledge source ${source}`);
    if (source.startsWith("jira:")) need("ticket-jira", `knowledge source ${source}`);
  }
  return needs;
}
