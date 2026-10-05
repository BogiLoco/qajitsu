import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import type { ResolvedEnvironment } from "@qajitsu/core";
import type { RunSession } from "../session.js";

/** Runs a hook script: command, argument array, environment, working folder and timeout. */
export type HookExec = (
  command: string,
  args: readonly string[],
  options: {
    readonly env: Readonly<Record<string, string>>;
    readonly cwd: string;
    readonly timeoutMs: number;
  },
) => Promise<{ readonly output: string; readonly ok: boolean }>;

const execHook: HookExec = (command, args, options) =>
  new Promise((done) => {
    execFile(
      command,
      [...args],
      {
        env: { PATH: process.env["PATH"] ?? "", ...options.env },
        cwd: options.cwd,
        timeout: options.timeoutMs,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        done({ output: `${stdout}${stderr}`, ok: error === null });
      },
    );
  });

/** Outcome of a run hook; `ok` when the hook is not configured. */
export interface HookOutcome {
  readonly ok: boolean;
  readonly script?: string;
  /** The masked hook log, `logs/<kind>.log`. */
  readonly log?: string;
}

/**
 * Runs the project's `setup` or `teardown` hook from `.qa/hooks/` (REQ-GEN-01/AC2) in the trusted parent with
 * only `PATH`, `BASE_URL`, `QAJITSU_RUN`, `QAJITSU_TICKET` and `QAJITSU_ENV`: no secrets. The output is masked
 * into `logs/<kind>.log`. The hook decides nothing about statuses; the caller does.
 *
 * @param session - The run.
 * @param kind - Which hook.
 * @param env - The environment of the run.
 * @param exec - Replaced in tests.
 */
export async function runRunHook(
  session: RunSession,
  kind: "setup" | "teardown",
  env: ResolvedEnvironment,
  exec: HookExec = execHook,
): Promise<HookOutcome> {
  const { hooks } = session.project.config;
  const script = hooks[kind];
  if (script === undefined) return { ok: true };
  const hooksDir = resolve(session.project.qaDir, "hooks");
  const file = resolve(session.project.qaDir, script);
  const log = session.ws.path("logs", `${kind}.log`);
  const actor = { kind: "system", name: "orchestrator" } as const;
  if (!file.startsWith(`${hooksDir}${sep}`)) {
    await writeFile(log, `${script} is outside .qa/hooks/\n`, "utf8");
    session.events.emit("run", actor, `hook.${kind}`, { script, ok: false });
    return { ok: false, script, log };
  }
  // Account secrets are known to the masker before the hook writes anything (invariant 8).
  for (const account of Object.values(env.profile.accounts))
    for (const value of Object.values(account))
      if (typeof value === "string" && value.startsWith("secret://"))
        await session.resolveSecret(value).catch(() => undefined);
  const [command, args] = /\.(mjs|cjs|js)$/.test(file) ? [process.execPath, [file]] : [file, []];
  const result = await exec(command, args, {
    cwd: session.project.qaDir,
    timeoutMs: hooks.timeout_s * 1000,
    env: {
      BASE_URL: env.baseUrl,
      QAJITSU_RUN: session.ws.runId,
      QAJITSU_TICKET: session.ws.ticket,
      QAJITSU_ENV: env.name,
    },
  });
  await writeFile(log, session.masker.maskText(result.output), "utf8");
  session.events.emit("run", actor, `hook.${kind}`, { script, ok: result.ok });
  return { ok: result.ok, script, log };
}
