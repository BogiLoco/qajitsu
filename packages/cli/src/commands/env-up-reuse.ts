import { createRemoteEnvProvider } from "@qajitsu/adapter-env-remote";
import { resolveEnvironment, type ResolvedEnvironment } from "@qajitsu/core";
import type { RunSession } from "../session.js";

/**
 * The environment `qj env up` started from this run's worktree, when it still answers (REQ-EXEC-15/AC1, REQ-ENV-07/AC3). It listens on
 * 127.0.0.1 only, like a `qj run --build` environment, so no allowlist entry is needed for its random port.
 */
export async function runningBuild(
  session: RunSession,
  fetchFn: typeof globalThis.fetch,
): Promise<ResolvedEnvironment | undefined> {
  const recorded = session.ws.record.data["build"] as
    { readonly services?: Record<string, { readonly url?: string }> } | undefined;
  const services = Object.entries(recorded?.services ?? {});
  const base = session.project.config.build?.base_service;
  const url = (services.find(([name]) => name === base) ?? services[0])?.[1].url;
  if (url === undefined || !/^http:\/\/127\.0\.0\.1:\d+$/.test(url)) return undefined;
  const env = await resolveEnvironment({
    config: session.project.config,
    qaDir: session.project.qaDir,
    buildBaseUrl: url,
  }).catch(() => undefined);
  if (!env) return undefined;
  const reached = await createRemoteEnvProvider(env, fetchFn, { readVersion: false })
    .start()
    .catch(() => undefined);
  return reached?.health.ok ? env : undefined;
}
