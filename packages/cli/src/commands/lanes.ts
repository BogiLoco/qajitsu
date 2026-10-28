import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { loginAccounts } from "@qajitsu/adapter-env-remote";
import { createBrowserLogin } from "@qajitsu/adapter-runner-web";
import type { BrowserFactory, LoginContext, RunCasesOptions } from "@qajitsu/adapter-runner-api";
import {
  accountsUsedBy,
  CaseResultFileSchema,
  type AccountLeases,
  type CaseResultFile,
  type Plan,
  type ResolvedEnvironment,
  type BrowserState,
} from "@qajitsu/core";
import type { RunSession } from "../session.js";
import type { PreparedMobile } from "./mobile.js";

const SYSTEM = { kind: "system", name: "orchestrator" } as const;

/**
 * Runs tasks with at most `limit` at a time, in order; every task runs to its end even when another fails, then the
 * first failure is thrown (a lane that fails never leaves others running unobserved).
 */
export async function runLimited(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0;
  const errors: unknown[] = [];
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const task = tasks[next];
      next += 1;
      try {
        await task?.();
      } catch (error) {
        errors.push(error);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  if (errors.length > 0) throw errors[0];
}

/**
 * The login of an attempt with account pools (REQ-ENV-09): the attempt holds, for each alias its spec mentions, one
 * pool account for itself, logs in only those, and gives them back when it ends. A login that fails gives them back
 * at once.
 */
export function accountLogin(
  env: ResolvedEnvironment,
  leases: AccountLeases,
  deps: Parameters<typeof loginAccounts>[1],
  /** Accounts a case names in its data (its sessions, REQ-EXEC-62/AC3), leased besides those its spec names. */
  caseAliases: (caseId: string) => readonly string[] = () => [],
): RunCasesOptions["login"] {
  const aliases = Object.keys(env.profile.accounts);
  // REQ-EXEC-55/AC2: SSO logins run in a browser; with `reuse` one login serves every case of this run.
  const withBrowser: Parameters<typeof loginAccounts>[1] = {
    ...deps,
    browserLogin: deps.browserLogin ?? createBrowserLogin(),
    sessionCache: deps.sessionCache ?? new Map<string, BrowserState>(),
  };
  const used = new Map<string, Promise<string[]>>();
  const aliasesOf = (specFile: string): Promise<string[]> => {
    let found = used.get(specFile);
    if (!found) {
      found = readFile(specFile, "utf8").then((text) => accountsUsedBy(text, aliases));
      used.set(specFile, found);
    }
    return found;
  };
  return async (context: LoginContext) => {
    const lease = await leases.acquire({
      caseId: context.caseId,
      lane: context.lane,
      aliases: [
        ...new Set([
          ...(await aliasesOf(context.specFile)),
          ...caseAliases(context.caseId).filter((a) => aliases.includes(a)),
        ]),
      ],
    });
    try {
      const session = await loginAccounts(env, withBrowser, lease.members);
      return {
        ...session,
        leased: lease.labels,
        release: () => {
          lease.release();
        },
      };
    } catch (error) {
      lease.release();
      throw error;
    }
  };
}

const blocked = (caseId: string, reason: string): CaseResultFile =>
  CaseResultFileSchema.parse({
    schema: 1,
    caseId,
    runner: "api",
    attempts: [{ attempt: 1, outcome: "error", assertions: [], error: reason, steps: [], evidence: [] }],
  });

async function writeBlockedIn(
  dir: string,
  cases: Plan["cases"],
  reason: string,
): Promise<Map<string, CaseResultFile>> {
  await mkdir(dir, { recursive: true });
  const out = new Map<string, CaseResultFile>();
  for (const c of cases) {
    const result = blocked(c.id, reason);
    await writeFile(join(dir, `${c.id}.json`), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    out.set(c.id, result);
  }
  return out;
}

/** The results folder of a mobile device in matrix mode: the primary device writes the run's results. */
export const deviceResultsDir = (session: RunSession, name: string, primary: boolean): string =>
  primary ? session.ws.path("results") : session.ws.path("results", "devices", name);

/**
 * The mobile lane (REQ-EXEC-19, REQ-EXEC-20, REQ-EXEC-10/AC2): every device runs one case at a time. `split` divides
 * the cases among the devices that started; `matrix` runs every case on every device, the primary device writing
 * the run's results and the others `results/devices/<name>/` with evidence under `devices/<name>/`. A device that did
 * not start is reported; in matrix mode its results are BLOCKED with the reason (never skipped), in split mode its
 * cases go to the other devices.
 *
 * @returns The primary results of the mobile cases.
 */
export async function runMobileLane(input: {
  readonly session: RunSession;
  readonly plan: Plan;
  readonly cases: Plan["cases"];
  readonly device: Extract<PreparedMobile, { ok: true }>;
  readonly distribute: "split" | "matrix";
  readonly sequential: boolean;
  /** Runs cases on one device; `primary` runs carry the live progress and pauses. */
  readonly run: (
    factory: BrowserFactory,
    cases: Plan["cases"],
    where: { readonly resultsDir: string; readonly evidencePrefix?: string; readonly primary: boolean },
  ) => Promise<Map<string, CaseResultFile>>;
  readonly warn: (text: string) => void;
}): Promise<Map<string, CaseResultFile>> {
  const { session, cases, device } = input;
  const names = device.names ?? device.factories.map((_, i) => `device-${String(i + 1)}`);
  const started = device.factories.map((factory, i) => ({
    factory,
    name: names[i] ?? `device-${String(i + 1)}`,
  }));
  for (const f of device.failed ?? []) {
    input.warn(`Mobile device ${f.name} did not start: ${f.reason}\n`);
    session.events.emit("run", SYSTEM, "mobile.device.failed", {
      device: f.name,
      reason: f.reason.slice(0, 500),
    });
  }
  const out = new Map<string, CaseResultFile>();
  const tasks: (() => Promise<void>)[] = [];
  if (input.distribute === "split") {
    // REQ-EXEC-10/AC2: round-robin over the devices that started.
    for (const [d, s] of started.entries()) {
      const mine = cases.filter((_, i) => i % started.length === d);
      if (mine.length === 0) continue;
      tasks.push(async () => {
        for (const [id, r] of await input.run(s.factory, mine, {
          resultsDir: session.ws.path("results"),
          primary: true,
        }))
          out.set(id, r);
      });
    }
  } else {
    const primary = device.primary ?? names[0] ?? "device-1";
    session.events.emit("run", SYSTEM, "mobile.matrix", {
      devices: [...started.map((s) => s.name), ...(device.failed ?? []).map((f) => f.name)],
      primary,
    });
    for (const f of device.failed ?? []) {
      const isPrimary = f.name === primary;
      const written = await writeBlockedIn(
        deviceResultsDir(session, f.name, isPrimary),
        cases,
        `mobile device ${f.name} not available: ${f.reason}`,
      );
      if (isPrimary) for (const [id, r] of written) out.set(id, r);
    }
    for (const s of started) {
      const isPrimary = s.name === primary;
      tasks.push(async () => {
        const dir = deviceResultsDir(session, s.name, isPrimary);
        await mkdir(dir, { recursive: true });
        const ran = await input.run(s.factory, cases, {
          resultsDir: dir,
          primary: isPrimary,
          ...(isPrimary ? {} : { evidencePrefix: `devices/${s.name}/` }),
        });
        if (isPrimary) for (const [id, r] of ran) out.set(id, r);
      });
    }
  }
  await runLimited(tasks, input.sequential ? 1 : tasks.length);
  return out;
}
