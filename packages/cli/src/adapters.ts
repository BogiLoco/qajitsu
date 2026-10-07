import { join } from "node:path";
import { createGitHubCodeHost } from "@qajitsu/adapter-codehost-github";
import { createGitLabCodeHost } from "@qajitsu/adapter-codehost-gitlab";
import { createLocalCodeHost } from "@qajitsu/adapter-codehost-local";
import {
  createAwsSecretProvider,
  createGcpSecretProvider,
  createOnePasswordSecretProvider,
  type SecretCliExec,
} from "@qajitsu/adapter-secrets-cli";
import { createDopplerSecretProvider } from "@qajitsu/adapter-secrets-doppler";
import { createEnvSecretProvider } from "@qajitsu/adapter-secrets-env";
import { createVaultSecretProvider } from "@qajitsu/adapter-secrets-vault";
import { createFileTicketSource, createJiraCloudTicketSource } from "@qajitsu/adapter-ticket-jira";
import {
  ConfigError,
  createSecretResolver,
  type AdapterDeps,
  type CodeHost,
  type GitExec,
  type ResolvedProject,
  type TicketSource,
} from "@qajitsu/core";
import type { Masker } from "@qajitsu/steps";
import type { LoadedProject } from "./project.js";
import { resolveConfigPath } from "./project.js";

/** Process-level ports the CLI injects into adapters. */
export interface RuntimePorts {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly home: string;
  readonly now: () => Date;
  readonly random: () => number;
  readonly fetch: typeof globalThis.fetch;
  readonly gitExec: GitExec;
  /** The project the command runs in, resolved before it starts (ADR-0006). */
  readonly project?: ResolvedProject;
  /** Runs the `op`, `aws` and `gcloud` CLIs of secret managers (replaced in tests). */
  readonly secretCliExec?: SecretCliExec;
}

/** Adapters for one project. */
export interface ProjectAdapters {
  readonly ticketSource: TicketSource;
  readonly codeHosts: Readonly<Record<string, CodeHost>>;
}

/**
 * The secret resolver of the CLI: `env` provider over the process environment and the project's
 * `.env.local`; every resolved value is registered with the masker (REQ-CFG-03, invariant 8).
 */
export function createCliSecretResolver(project: LoadedProject, ports: RuntimePorts, masker: Masker) {
  const env = createEnvSecretProvider({ env: ports.env, envFile: join(project.projectDir, ".env.local") });
  // Tokens of secret managers are bootstrap secrets from `env`; they are masked like every other value.
  const bootstrap = (ref: string) => async (): Promise<string> => {
    const value = await env.resolve(ref);
    masker.register(value);
    return value;
  };
  const { vault, doppler, op, aws, gcp } = project.config.secrets;
  const cli = { env: ports.env, ...(ports.secretCliExec ? { exec: ports.secretCliExec } : {}) };
  return createSecretResolver(
    [
      env,
      ...(vault
        ? [
            createVaultSecretProvider({
              address: vault.address,
              mount: vault.mount,
              ...(vault.namespace ? { namespace: vault.namespace } : {}),
              token: bootstrap(vault.token),
              fetch: ports.fetch,
            }),
          ]
        : []),
      ...(doppler
        ? [
            createDopplerSecretProvider({
              project: doppler.project,
              config: doppler.config,
              token: bootstrap(doppler.token),
              fetch: ports.fetch,
            }),
          ]
        : []),
      ...(op ? [createOnePasswordSecretProvider(cli)] : []),
      ...(aws
        ? [
            createAwsSecretProvider({
              ...cli,
              region: aws.region,
              ...(aws.profile ? { profile: aws.profile } : {}),
            }),
          ]
        : []),
      ...(gcp ? [createGcpSecretProvider({ ...cli, project: gcp.project })] : []),
    ],
    (value) => {
      masker.register(value);
    },
  );
}

/**
 * Builds the adapters a project's configuration asks for. This is the adapter registry: core never
 * imports adapters (invariant 12), the CLI wires them.
 *
 * @param project - Loaded project.
 * @param deps - Adapter dependencies (fetch, logger, clock, secret resolver).
 * @param ports - Runtime ports.
 */
export function buildAdapters(
  project: LoadedProject,
  deps: AdapterDeps,
  ports: RuntimePorts,
): ProjectAdapters {
  const { config, qaDir } = project;
  const jira = config.jira;
  const ticketSource =
    jira.type === "file"
      ? createFileTicketSource(resolveConfigPath(jira.tickets_dir ?? ".", qaDir, ports.home))
      : createJiraCloudTicketSource(
          {
            baseUrl: jira.base_url ?? "",
            flavor: jira.type === "datacenter" ? "datacenter" : "cloud",
            email: jira.email,
            token: jira.token ?? "",
            acceptanceCriteriaField: jira.acceptance_criteria_field,
            projectKey: jira.project_key,
          },
          deps,
        );
  const codeHosts: Record<string, CodeHost> = {};
  for (const [alias, host] of Object.entries(config.code_hosts)) {
    switch (host.type) {
      case "github":
        codeHosts[alias] = createGitHubCodeHost(
          {
            alias,
            baseUrl: host.base_url,
            token: host.token,
            app: host.app
              ? {
                  appId: host.app.app_id,
                  installationId: host.app.installation_id,
                  privateKey: host.app.private_key,
                }
              : undefined,
          },
          deps,
        );
        break;
      case "gitlab":
        codeHosts[alias] = createGitLabCodeHost(
          { alias, baseUrl: host.base_url, token: host.token ?? "" },
          deps,
        );
        break;
      case "local":
        if (host.root === undefined)
          throw new ConfigError("CONFIG_INVALID", `code_hosts.${alias}.root is required.`, {});
        codeHosts[alias] = createLocalCodeHost(
          { alias, root: resolveConfigPath(host.root, qaDir, ports.home) },
          ports.gitExec,
        );
        break;
    }
  }
  return { ticketSource, codeHosts };
}
