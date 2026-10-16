import { accountMembers, LANES, type Lane } from "../config/env-profile.js";
import type { EnvProfileSchema } from "../config/env-profile.js";
import { QajitsuError } from "../errors.js";
import type { z } from "zod";

type Profile = z.infer<typeof EnvProfileSchema>;

/** What a case asks for: the aliases its spec uses, in the lane it runs in. */
export interface LeaseRequest {
  readonly caseId: string;
  readonly lane: Lane;
  readonly aliases: readonly string[];
}

/** Accounts a running case holds (REQ-ENV-09/AC2). */
export interface AccountLease {
  /** Index of the pool member per alias. */
  readonly members: Readonly<Record<string, number>>;
  /** `user:standard#2` per alias, for the journal: never the user name (AC5). */
  readonly labels: Readonly<Record<string, string>>;
  /** Gives the accounts back; a second call does nothing. */
  release(): void;
}

/** Hands out pool accounts to running cases. */
export interface AccountLeases {
  /**
   * Takes one account of every alias of the request that has accounts, all at once, or waits until it can.
   *
   * @throws {QajitsuError} `ACCOUNT_POOL_EXHAUSTED` when no account is free in time, or none may run in the lane.
   */
  acquire(request: LeaseRequest): Promise<AccountLease>;
  /** Accounts of an alias held right now. */
  inUse(alias: string): number;
}

interface Pool {
  readonly lanes: readonly (readonly Lane[] | undefined)[];
  readonly shared: boolean;
  readonly held: boolean[];
}

interface Waiter {
  readonly request: LeaseRequest;
  readonly resolve: (lease: AccountLease) => void;
  done: boolean;
}

const exhausted = (message: string, caseId: string): QajitsuError =>
  new QajitsuError("ACCOUNT_POOL_EXHAUSTED", message, { caseId });

/**
 * Account pools of an environment profile (REQ-ENV-09): every running case holds, for each alias its spec uses, one
 * account for itself until it releases it; a `shared` alias is used by everyone. A case takes all its aliases at once
 * or none, so two cases waiting for each other's accounts cannot deadlock. A case that finds no free account waits up
 * to `waitMs`, then fails with the reason; it is never given an account in use.
 *
 * @param profile - The environment profile.
 * @param options - How long a case waits, and the sleep (replaced in tests).
 */
export function createAccountLeases(
  profile: Profile,
  options: { readonly waitMs: number; readonly sleep?: (ms: number) => Promise<void> },
): AccountLeases {
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((done) => {
        setTimeout(done, ms).unref();
      }));
  const pools = new Map<string, Pool>(
    Object.entries(profile.accounts).map(([alias, entry]) => {
      const { members, shared } = accountMembers(entry);
      return [alias, { lanes: members.map((m) => m.lanes), shared, held: members.map(() => false) }];
    }),
  );
  const waiters: Waiter[] = [];
  const allowed = (pool: Pool, i: number, lane: Lane): boolean => pool.lanes[i]?.includes(lane) ?? true;
  const wanted = (request: LeaseRequest): string[] =>
    [...new Set(request.aliases)].filter((a) => pools.has(a)).sort();

  const take = (request: LeaseRequest): AccountLease | undefined => {
    const members: Record<string, number> = {};
    for (const alias of wanted(request)) {
      const pool = pools.get(alias);
      if (!pool) continue;
      const free = pool.held.findIndex((h, i) => (pool.shared || !h) && allowed(pool, i, request.lane));
      if (free < 0) return undefined;
      members[alias] = free;
    }
    for (const [alias, i] of Object.entries(members)) {
      const pool = pools.get(alias);
      if (pool && !pool.shared) pool.held[i] = true;
    }
    let released = false;
    return {
      members,
      labels: Object.fromEntries(Object.entries(members).map(([a, i]) => [a, `${a}#${String(i + 1)}`])),
      release: () => {
        if (released) return;
        released = true;
        for (const [alias, i] of Object.entries(members)) {
          const pool = pools.get(alias);
          if (pool && !pool.shared) pool.held[i] = false;
        }
        for (const w of [...waiters]) {
          if (w.done) continue;
          const lease = take(w.request);
          if (!lease) continue;
          w.done = true;
          waiters.splice(waiters.indexOf(w), 1);
          w.resolve(lease);
        }
      },
    };
  };

  return {
    acquire: async (request) => {
      for (const alias of wanted(request)) {
        const pool = pools.get(alias);
        if (pool && !pool.lanes.some((_, i) => allowed(pool, i, request.lane)))
          throw exhausted(
            `${request.caseId}: no account of ${alias} may be used in the ${request.lane} lane (accounts.${alias}: lanes)`,
            request.caseId,
          );
      }
      const now = take(request);
      if (now) return now;
      const busy = wanted(request).find((a) => {
        const pool = pools.get(a);
        return pool?.held.every((h, i) => h || !allowed(pool, i, request.lane)) === true;
      });
      const reason = exhausted(
        `${request.caseId}: no free account of ${busy ?? wanted(request).join(", ")} within ${String(Math.round(options.waitMs / 1000))} s; add accounts to the pool or run fewer cases at once`,
        request.caseId,
      );
      if (options.waitMs <= 0) throw reason;
      return new Promise<AccountLease>((resolve, reject) => {
        const waiter: Waiter = { request, resolve, done: false };
        waiters.push(waiter);
        void sleep(options.waitMs).then(() => {
          if (waiter.done) return;
          waiter.done = true;
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(reason);
        });
      });
    },
    inUse: (alias) => pools.get(alias)?.held.filter(Boolean).length ?? 0,
  };
}

/**
 * The account aliases a spec mentions: the ones it may use (`api.as("user:standard")`, `ui.as(...)`), and so the ones
 * a case holds while it runs (REQ-ENV-09/AC2). An alias built at run time is not found: it then has no account, which
 * fails the step instead of sharing one.
 *
 * @param source - The spec's source text.
 * @param aliases - The aliases of the environment profile.
 */
export function accountsUsedBy(source: string, aliases: readonly string[]): string[] {
  const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return aliases.filter((a) => new RegExp(`(?<![\\w:.-])${escape(a)}(?![\\w.-])`).test(source));
}

/**
 * Pools smaller than the number of cases that can need them at once (REQ-ENV-09/AC5): those cases wait.
 *
 * @param profile - The environment profile.
 * @param concurrency - Cases at once per lane.
 */
export function poolCapacityWarnings(
  profile: Profile,
  concurrency: Readonly<Record<Lane, number>>,
): string[] {
  const out: string[] = [];
  for (const [alias, entry] of Object.entries(profile.accounts)) {
    const { members, shared } = accountMembers(entry);
    if (shared) continue;
    const lanes = LANES.filter(
      (l) => concurrency[l] > 0 && members.some((m) => m.lanes?.includes(l) ?? true),
    );
    const need = lanes.reduce((sum, l) => sum + concurrency[l], 0);
    if (need > members.length)
      out.push(
        `${alias} has ${String(members.length)} account${members.length === 1 ? "" : "s"}, up to ${String(need)} cases can need it at once (${lanes.map((l) => `${l} ${String(concurrency[l])}`).join(", ")}); the others wait for a free one`,
      );
  }
  return out;
}
