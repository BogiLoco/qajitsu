import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loginAccounts } from "@qajitsu/adapter-env-remote";
import {
  createAccountLeases,
  waitForReadiness,
  type GitExec,
  type Publisher,
  type ReadinessConfig,
  type ReadinessReport,
  type ResolvedEnvironment,
} from "@qajitsu/core";
import type { Masker } from "@qajitsu/steps";
import { accountHeaders } from "./commands/lanes.js";
import type { RunSession } from "./session.js";

/** A readiness script of `.qa/hooks/`: Node, an argument array, a minimal environment and a time limit. */
const runScript = (script: string, baseUrl: string): Promise<{ ok: boolean; output: string }> =>
  new Promise((done) => {
    execFile(
      process.execPath,
      [script],
      {
        env: { PATH: process.env["PATH"] ?? "", BASE_URL: baseUrl },
        timeout: 60_000,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        done({ ok: error === null, output: (error === null ? stdout : `${stdout}${stderr}`).trim() });
      },
    );
  });

/**
 * Checks the environment's readiness for the run's ticket (REQ-ENV-13/AC1..AC4) with the run's environment, accounts
 * and repositories: version sources and checks are read only on allowed origins, as the configured accounts; the
 * deployed commit is compared with the change in the run's worktree; while not ready it is checked again as
 * `wait` allows.
 *
 * @param session - The run.
 * @param env - The resolved environment.
 * @param options - The readiness configuration, whether the environment was built from the worktree, the fetch, git
 *   and secret seams, and a sleep (replaced in tests).
 */
export async function checkRunReadiness(
  session: RunSession,
  env: ResolvedEnvironment,
  options: {
    readonly config: ReadinessConfig;
    readonly built: boolean;
    readonly fetch: typeof globalThis.fetch;
    readonly gitExec: GitExec;
    readonly masker: Masker;
    readonly sleep?: (ms: number) => Promise<void>;
    readonly onRound?: (report: ReadinessReport) => void;
  },
): Promise<ReadinessReport> {
  const { ws, project } = session;
  const allowed = new Set([
    env.origin,
    ...project.config.environments.allowlist.map((u) => new URL(u).origin),
  ]);
  const loginDeps = {
    fetch: options.fetch,
    qaDir: project.qaDir,
    resolveSecret: (r: string) => session.resolveSecret(r),
    registerSecret: (v: string) => {
      options.masker.register(v);
    },
  };
  const leases = createAccountLeases(env.profile, { waitMs: project.config.execution.account_wait_s * 1000 });
  const headersFor = accountHeaders(env, leases, loginDeps);
  const ticket = JSON.parse(await readFile(ws.path("ticket", "ticket.json"), "utf8").catch(() => "{}")) as {
    labels?: unknown;
  };
  return waitForReadiness(
    options.config,
    {
      labels: Array.isArray(ticket.labels)
        ? ticket.labels.filter((l): l is string => typeof l === "string")
        : [],
      repos: Object.entries(ws.record.repos)
        .filter(([, r]) => r.role !== "tests")
        .map(([alias, r]) => ({ alias, sha: r.sha })),
      built: options.built,
      get: async (target, as) => {
        const url = new URL(target, env.baseUrl);
        // Invariant 10: readiness reads only the environment and the origins the project allows.
        if (!allowed.has(url.origin)) throw new Error(`${url.origin} is not an allowed origin`);
        const res = await options.fetch(url, {
          headers: { ...(await headersFor(as)) },
          redirect: "manual",
          signal: AbortSignal.timeout(15_000),
        });
        return { status: res.status, text: (await res.text()).slice(0, 100_000) };
      },
      isAncestor: async (alias, ancestor, descendant) => {
        try {
          await options.gitExec([
            "-C",
            ws.path("repos", alias),
            "merge-base",
            "--is-ancestor",
            ancestor,
            descendant,
          ]);
          return true;
        } catch (error) {
          // 1: not an ancestor; anything else (128: an unknown commit) says nothing.
          return (error as { code?: unknown }).code === 1 ? false : undefined;
        }
      },
      runScript: (script) => runScript(resolve(project.qaDir, script), env.baseUrl),
      login: async (aliases) => {
        const lease = await leases.acquire({ caseId: "readiness", lane: "api", aliases: [...aliases] });
        try {
          const accountSession = await loginAccounts(env, loginDeps, lease.members);
          const missing = aliases.filter((a) => accountSession.accounts[a] === undefined);
          if (missing.length > 0) throw new Error(`no account for ${missing.join(", ")}`);
        } finally {
          lease.release();
        }
      },
      now: () => new Date(),
    },
    options.sleep ??
      ((ms) =>
        new Promise((done) => {
          setTimeout(done, ms);
        })),
    options.onRound,
  );
}

/** The readiness report as lines for the terminal and the ticket comment (REQ-ENV-13/AC3). */
export function formatEnvReadiness(report: ReadinessReport): string[] {
  return [
    `Environment readiness: ${report.ready ? "READY" : "NOT READY"}${report.rounds > 1 ? ` after ${String(report.rounds)} checks` : ""}${report.override ? ` · run anyway by ${report.override.by}: ${report.override.reason}` : ""}`,
    ...report.checks.map(
      (c) =>
        `  ${c.ok ? "✔" : "✘"} ${c.name}: ${c.observed}${c.ok || c.expected === undefined ? "" : ` (expected ${c.expected})`}`,
    ),
  ];
}

/** Posts the readiness report to the ticket as configured (REQ-ENV-13/AC3); a failed comment never changes the run. */
export async function commentEnvReadiness(
  session: RunSession,
  report: ReadinessReport,
  config: ReadinessConfig,
  publisher: Publisher,
  masker: Masker,
): Promise<string | undefined> {
  if (config.comment === "never" || (config.comment === "not_ready" && report.ready && !report.override))
    return undefined;
  const lines = formatEnvReadiness(report).map((l) => masker.maskText(l));
  const title = `QAJitsu environment readiness for ${session.ws.ticket}`;
  try {
    await publisher.publish({
      ticket: session.ws.ticket,
      runId: session.ws.runId,
      name: "environment-readiness",
      comment: {
        adf: {
          type: "doc",
          version: 1,
          content: [
            { type: "paragraph", content: [{ type: "text", text: title, marks: [{ type: "strong" }] }] },
            ...lines.map((line) => ({ type: "paragraph", content: [{ type: "text", text: line }] })),
          ],
        },
        wiki: `*${title}*\n{noformat}\n${lines.join("\n").replace(/\{noformat\}/gi, "{ noformat }")}\n{noformat}`,
      },
      attachments: [],
    });
    return undefined;
  } catch (error) {
    return masker.maskText(error instanceof Error ? error.message : String(error));
  }
}
