import { z } from "zod";

const ScriptPath = z
  .string()
  .regex(/^hooks\/[\w.-]+(\/[\w.-]+)*$/, "Scripts live in .qa/hooks/")
  .refine((p) => !p.split("/").includes(".."), "Scripts live in .qa/hooks/");
const AccountAlias = z
  .string()
  .regex(/^[a-z][a-z0-9_-]*:[a-z0-9_.-]+$/, "An account alias like user:standard");
/** A path on the environment (`/health`) or a full URL on its allowlist (a deployment API, a mock). */
const Target = z.string().regex(/^(\/|https?:\/\/)\S*$/, "A path like /version or an http(s) URL");
const Labels = z.array(z.string().min(1).max(100)).max(20).optional();

/**
 * Environment readiness for a ticket (REQ-ENV-13), under `environments.readiness`: where each repository's deployed
 * version is read, which checks must hold before the first case, how long to wait for a deployment, and when the
 * result is commented on the ticket.
 */
export const ReadinessConfigSchema = z.strictObject({
  /**
   * Per repository alias of the change: a JSON endpoint (`url` and the dotted path of the commit in `sha`: a version
   * endpoint, the deployments API of GitHub or GitLab, Argo CD) or a script of `.qa/hooks/` that prints the commit
   * (container image labels, a registry).
   */
  versions: z
    .record(
      z.string().regex(/^[a-z][a-z0-9_-]*$/),
      z.union([
        z.strictObject({
          url: Target,
          sha: z.string().min(1).max(200).default("sha"),
          as: AccountAlias.optional(),
        }),
        z.strictObject({ command: ScriptPath }),
      ]),
    )
    .default({}),
  /** Checks before the first case; `labels` limits one to tickets with one of them (a feature flag the ticket needs). */
  checks: z
    .array(
      z.union([
        z.strictObject({
          name: z.string().min(1).max(100),
          url: Target,
          status: z.number().int().min(100).max(599).default(200),
          /** Dotted path of a value in the JSON answer that must equal `equals` (a migration, a flag). */
          json: z.string().min(1).max(200).optional(),
          equals: z.unknown().optional(),
          as: AccountAlias.optional(),
          labels: Labels,
        }),
        z.strictObject({
          name: z.string().min(1).max(100),
          accounts: z.array(AccountAlias).min(1),
          labels: Labels,
        }),
        z.strictObject({ name: z.string().min(1).max(100), command: ScriptPath, labels: Labels }),
      ]),
    )
    .max(50)
    .default([]),
  /** Waiting for a deployment (AC4): checked again every `interval_s` until ready or `timeout_s` has passed. */
  wait: z
    .strictObject({
      timeout_s: z.number().int().min(1).max(86_400),
      interval_s: z.number().int().min(1).max(3600),
    })
    .refine((w) => w.interval_s <= w.timeout_s, "interval_s must not exceed timeout_s")
    .optional(),
  /** When the readiness report is commented on the ticket (AC3). */
  comment: z.enum(["never", "not_ready", "always"]).default("not_ready"),
});

/** Parsed `environments.readiness`. */
export type ReadinessConfig = z.infer<typeof ReadinessConfigSchema>;

/** One check of the readiness report: what was expected and what was observed (REQ-ENV-13/AC3). */
export interface ReadinessCheck {
  readonly name: string;
  readonly kind: "version" | "http" | "accounts" | "command";
  readonly ok: boolean;
  readonly observed: string;
  readonly expected?: string;
}

/** The environment readiness of a run (REQ-ENV-13/AC3), kept in `run.json` as `data.readiness_env`. */
export interface ReadinessReport {
  readonly ready: boolean;
  readonly checkedAt: string;
  /** How many times it was checked (more than one while waiting for a deployment, AC4). */
  readonly rounds: number;
  readonly checks: readonly ReadinessCheck[];
  /** A person ran anyway (AC5): every result of the run is "environment not confirmed". */
  readonly override?: { readonly by: string; readonly reason: string; readonly at: string };
}

/** What the readiness check reads from the environment, the repositories and the project; all injected. */
export interface ReadinessDeps {
  /** The ticket's labels, for checks limited to some tickets. */
  readonly labels: readonly string[];
  /** The repositories of the change with the commit analysed. */
  readonly repos: readonly { readonly alias: string; readonly sha: string }[];
  /** The environment runs the fetched worktree (`--build`): its versions are the change's. */
  readonly built: boolean;
  /** GETs a path of the environment or an allowed URL, as an account alias when given. */
  readonly get: (target: string, as?: string) => Promise<{ readonly status: number; readonly text: string }>;
  /** Whether `ancestor` is `descendant` or one of its ancestors in the repository; undefined when a commit is unknown. */
  readonly isAncestor: (alias: string, ancestor: string, descendant: string) => Promise<boolean | undefined>;
  /** Runs a script of `.qa/hooks/`; its trimmed output and whether it exited with 0. */
  readonly runScript: (script: string) => Promise<{ readonly ok: boolean; readonly output: string }>;
  /** Logs in the account aliases; throws with the reason when one cannot. */
  readonly login: (aliases: readonly string[]) => Promise<void>;
  readonly now: () => Date;
}

const at = (value: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>(
      (v, k) => (v !== null && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined),
      value,
    );
const short = (sha: string): string => (/^[0-9a-f]{40}$/.test(sha) ? sha.slice(0, 12) : sha.slice(0, 60));
const reason = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).slice(0, 200);
const json = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

/** The deployed commit of one repository and how it relates to the change (AC1). */
async function versionCheck(
  alias: string,
  change: string,
  source: ReadinessConfig["versions"][string] | undefined,
  deps: ReadinessDeps,
): Promise<ReadinessCheck> {
  const base = {
    name: `version of ${alias}`,
    kind: "version" as const,
    expected: `contains ${short(change)}`,
  };
  if (deps.built) return { ...base, ok: true, observed: "built from the run's worktree" };
  if (!source) return { ...base, ok: true, observed: "not checked: no version source for this repository" };
  let deployed: string;
  try {
    if ("command" in source) {
      const out = await deps.runScript(source.command);
      if (!out.ok)
        return { ...base, ok: false, observed: `${source.command} failed: ${out.output.slice(0, 200)}` };
      deployed = out.output.trim().split("\n").at(-1)?.trim() ?? "";
    } else {
      const res = await deps.get(source.url, source.as);
      if (res.status < 200 || res.status > 299)
        return { ...base, ok: false, observed: `${source.url} answered ${String(res.status)}` };
      const value = at(json(res.text), source.sha);
      deployed = typeof value === "string" ? value : "";
    }
  } catch (error) {
    return { ...base, ok: false, observed: `cannot read the deployed version: ${reason(error)}` };
  }
  if (deployed === "") return { ...base, ok: false, observed: "no deployed version found" };
  if (deployed === change)
    return { ...base, ok: true, observed: `deployed ${short(deployed)}, the change itself` };
  const contains = await deps.isAncestor(alias, change, deployed).catch(() => undefined);
  if (contains === true)
    return { ...base, ok: true, observed: `deployed ${short(deployed)} contains the change` };
  return {
    ...base,
    ok: false,
    observed:
      contains === false
        ? `deployed ${short(deployed)} does not contain the change (older or another branch)`
        : `deployed ${short(deployed)} is not a commit of the repository`,
  };
}

/** One configured check before the first case (AC2). */
async function check(c: ReadinessConfig["checks"][number], deps: ReadinessDeps): Promise<ReadinessCheck> {
  if ("accounts" in c) {
    try {
      await deps.login(c.accounts);
      return { name: c.name, kind: "accounts", ok: true, observed: `${c.accounts.join(", ")} logged in` };
    } catch (error) {
      return { name: c.name, kind: "accounts", ok: false, observed: `login failed: ${reason(error)}` };
    }
  }
  if ("command" in c) {
    const out = await deps
      .runScript(c.command)
      .catch((error: unknown) => ({ ok: false, output: reason(error) }));
    return {
      name: c.name,
      kind: "command",
      ok: out.ok,
      observed: out.output.slice(0, 200) || (out.ok ? "ok" : "failed"),
    };
  }
  const expected =
    c.json === undefined
      ? `status ${String(c.status)}`
      : `status ${String(c.status)}, ${c.json} = ${JSON.stringify(c.equals)}`;
  try {
    const res = await deps.get(c.url, c.as);
    if (res.status !== c.status)
      return { name: c.name, kind: "http", ok: false, expected, observed: `status ${String(res.status)}` };
    if (c.json === undefined)
      return { name: c.name, kind: "http", ok: true, expected, observed: `status ${String(res.status)}` };
    const value = at(json(res.text), c.json);
    const equal = JSON.stringify(value) === JSON.stringify(c.equals);
    return {
      name: c.name,
      kind: "http",
      ok: equal,
      expected,
      observed: `${c.json} = ${value === undefined ? "(absent)" : JSON.stringify(value).slice(0, 200)}`,
    };
  } catch (error) {
    return { name: c.name, kind: "http", ok: false, expected, observed: `not reachable: ${reason(error)}` };
  }
}

/**
 * Checks once whether the environment is ready for the ticket (REQ-ENV-13/AC1+AC2): the deployed version of every
 * repository of the change, then every configured check that applies to the ticket. Anything unreadable is not ready.
 *
 * @param config - `environments.readiness`.
 * @param deps - The environment, the repositories and the project, injected.
 */
export async function checkReadiness(config: ReadinessConfig, deps: ReadinessDeps): Promise<ReadinessReport> {
  const checks: ReadinessCheck[] = [];
  for (const repo of deps.repos)
    checks.push(await versionCheck(repo.alias, repo.sha, config.versions[repo.alias], deps));
  for (const c of config.checks)
    if (c.labels === undefined || c.labels.some((l) => deps.labels.includes(l)))
      checks.push(await check(c, deps));
  return { ready: checks.every((c) => c.ok), checkedAt: deps.now().toISOString(), rounds: 1, checks };
}

/**
 * Checks readiness and, while it is not ready, again every `wait.interval_s` until `wait.timeout_s` has passed
 * (REQ-ENV-13/AC4); the last report decides.
 *
 * @param config - `environments.readiness`; without `wait` it is checked once.
 * @param deps - As for {@link checkReadiness}.
 * @param sleep - Waits between rounds; `onRound` hears each report (progress for a person).
 */
export async function waitForReadiness(
  config: ReadinessConfig,
  deps: ReadinessDeps,
  sleep: (ms: number) => Promise<void>,
  onRound?: (report: ReadinessReport) => void,
): Promise<ReadinessReport> {
  // Time is counted as the waits between rounds, so a slow environment cannot stretch the timeout.
  let waitedMs = 0;
  let rounds = 0;
  for (;;) {
    rounds += 1;
    const report = { ...(await checkReadiness(config, deps)), rounds };
    onRound?.(report);
    const w = config.wait;
    if (report.ready || !w) return report;
    if (waitedMs + w.interval_s * 1000 > w.timeout_s * 1000) return report;
    await sleep(w.interval_s * 1000);
    waitedMs += w.interval_s * 1000;
  }
}

/**
 * One line for reports and the ticket comment (REQ-ENV-13/AC3+AC5): ready with its checks, not ready, or run anyway
 * by a person with the reason ("environment not confirmed").
 *
 * @param report - The run's readiness report.
 */
export function readinessSummary(report: ReadinessReport): string {
  const failed = report.checks.filter((c) => !c.ok).map((c) => c.name);
  if (report.override)
    return `environment not confirmed: run by ${report.override.by} although not ready (${failed.join(", ")}): ${report.override.reason}`;
  return report.ready
    ? `ready (${String(report.checks.length)} check(s))`
    : `not ready: ${failed.join(", ")}`;
}
