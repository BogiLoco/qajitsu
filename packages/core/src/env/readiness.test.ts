import { describe, expect, it } from "vitest";
import { ReadinessConfigSchema, checkReadiness, waitForReadiness, type ReadinessDeps } from "./readiness.js";

const CHANGE = "a".repeat(40);
const MERGED = "b".repeat(40);
const OLDER = "c".repeat(40);

const deps = (
  over: Partial<ReadinessDeps> = {},
  answers: Record<string, { status: number; body: unknown }> = {},
) => {
  const asked: string[] = [];
  const d: ReadinessDeps = {
    labels: ["low-stock"],
    repos: [{ alias: "shop", sha: CHANGE }],
    built: false,
    get: (target, as) => {
      asked.push(`${target}${as ? ` as ${as}` : ""}`);
      const a = answers[target];
      if (!a) return Promise.reject(new Error("connect ECONNREFUSED"));
      return Promise.resolve({
        status: a.status,
        text: typeof a.body === "string" ? a.body : JSON.stringify(a.body),
      });
    },
    isAncestor: (_, ancestor, descendant) =>
      Promise.resolve(
        descendant === MERGED && ancestor === CHANGE ? true : descendant === OLDER ? false : undefined,
      ),
    runScript: () => Promise.resolve({ ok: true, output: "ok" }),
    login: () => Promise.resolve(),
    now: () => new Date("2026-10-31T10:00:00Z"),
    ...over,
  };
  return { d, asked };
};

const config = ReadinessConfigSchema.parse({
  versions: { shop: { url: "/version", sha: "sha" } },
  checks: [
    { name: "api health", url: "/health" },
    {
      name: "migrations",
      url: "/admin/migrations",
      json: "latest",
      equals: "2026_10_31_stock",
      as: "user:admin",
    },
    { name: "low stock flag", url: "/flags", json: "low_stock_badge", equals: true, labels: ["low-stock"] },
    { name: "checkout flag", url: "/flags", json: "new_checkout", equals: true, labels: ["checkout"] },
    { name: "test accounts", accounts: ["user:standard"] },
  ],
});

const healthy = {
  "/health": { status: 200, body: { status: "ok" } },
  "/admin/migrations": { status: 200, body: { latest: "2026_10_31_stock" } },
  "/flags": { status: 200, body: { low_stock_badge: true, new_checkout: false } },
};

describe("environment readiness for the ticket (REQ-ENV-13)", () => {
  it("REQ-ENV-13/AC1: the deployed commit is the change or contains it; older, unknown or missing is a named mismatch", async () => {
    for (const [deployed, ok, observed] of [
      [CHANGE, true, "deployed aaaaaaaaaaaa, the change itself"],
      [MERGED, true, "deployed bbbbbbbbbbbb contains the change"],
      [OLDER, false, "deployed cccccccccccc does not contain the change (older or another branch)"],
      ["d".repeat(40), false, "deployed dddddddddddd is not a commit of the repository"],
    ] as const) {
      const { d } = deps({}, { ...healthy, "/version": { status: 200, body: { sha: deployed } } });
      const report = await checkReadiness(config, d);
      expect(report.checks[0]).toEqual({
        name: "version of shop",
        kind: "version",
        ok,
        observed,
        expected: "contains aaaaaaaaaaaa",
      });
    }
    const missing = await checkReadiness(
      config,
      deps({}, { ...healthy, "/version": { status: 200, body: {} } }).d,
    );
    expect(missing.checks[0]).toMatchObject({ ok: false, observed: "no deployed version found" });
    const down = await checkReadiness(config, deps({}, healthy).d);
    expect(down.checks[0]).toMatchObject({
      ok: false,
      observed: "cannot read the deployed version: connect ECONNREFUSED",
    });
    // A version read by a script (container image labels, a registry): its last line is the commit.
    const script = ReadinessConfigSchema.parse({ versions: { shop: { command: "hooks/deployed.mjs" } } });
    const byScript = await checkReadiness(
      script,
      deps({ runScript: () => Promise.resolve({ ok: true, output: `label\n${MERGED}\n` }) }).d,
    );
    expect(byScript.checks[0]).toMatchObject({
      ok: true,
      observed: "deployed bbbbbbbbbbbb contains the change",
    });
    // A built environment runs the worktree; a repository without a source is shown as not checked.
    const built = await checkReadiness(config, deps({ built: true }, healthy).d);
    expect(built.checks[0]).toMatchObject({ ok: true, observed: "built from the run's worktree" });
    const unlisted = await checkReadiness(
      config,
      deps({ repos: [{ alias: "web", sha: CHANGE }] }, healthy).d,
    );
    expect(unlisted.checks[0]).toMatchObject({
      ok: true,
      observed: "not checked: no version source for this repository",
    });
  });

  it("REQ-ENV-13/AC2: health, migrations, flags the ticket needs, accounts and dependencies are checked; each with its value", async () => {
    const { d, asked } = deps({}, { ...healthy, "/version": { status: 200, body: { sha: CHANGE } } });
    const report = await checkReadiness(config, d);
    expect(report.ready).toBe(true);
    expect(report.checks.map((c) => `${c.name}: ${c.observed}`)).toEqual([
      "version of shop: deployed aaaaaaaaaaaa, the change itself",
      "api health: status 200",
      'migrations: latest = "2026_10_31_stock"',
      "low stock flag: low_stock_badge = true",
      "test accounts: user:standard logged in",
    ]);
    // The checkout flag belongs to other tickets; the migration is read as the admin.
    expect(asked).toContain("/admin/migrations as user:admin");
    const broken = await checkReadiness(
      config,
      deps(
        { login: () => Promise.reject(new Error("user:standard: 401")) },
        {
          "/version": { status: 200, body: { sha: CHANGE } },
          "/health": { status: 503, body: "down" },
          "/admin/migrations": { status: 200, body: { latest: "2026_10_01_init" } },
          "/flags": { status: 200, body: {} },
        },
      ).d,
    );
    expect(broken.ready).toBe(false);
    expect(broken.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.observed}`)).toEqual([
      "api health: status 503",
      'migrations: latest = "2026_10_01_init"',
      "low stock flag: low_stock_badge = (absent)",
      "test accounts: login failed: user:standard: 401",
    ]);
  });

  it("REQ-ENV-13/AC4: waits for the deployment until ready or the timeout; the last round decides", async () => {
    let t = Date.parse("2026-10-31T10:00:00Z");
    let deployed = OLDER;
    const sleeps: number[] = [];
    const waiting = ReadinessConfigSchema.parse({
      versions: { shop: { url: "/version" } },
      wait: { timeout_s: 120, interval_s: 30 },
    });
    const { d } = deps({
      now: () => new Date(t),
      get: () => Promise.resolve({ status: 200, text: JSON.stringify({ sha: deployed }) }),
    });
    const sleep = (ms: number) => {
      sleeps.push(ms);
      t += ms;
      if (sleeps.length === 2) deployed = MERGED;
      return Promise.resolve();
    };
    const ready = await waitForReadiness(waiting, d, sleep);
    expect(ready).toMatchObject({ ready: true, rounds: 3 });
    expect(sleeps).toEqual([30_000, 30_000]);
    deployed = OLDER;
    sleeps.length = 0;
    const never = await waitForReadiness(
      waiting,
      { ...d, get: () => Promise.resolve({ status: 200, text: JSON.stringify({ sha: OLDER }) }) },
      sleep,
    );
    // Rounds at 0, 30, 60, 90 and 120 s.
    expect(never).toMatchObject({ ready: false, rounds: 5 });
    expect(
      await waitForReadiness(
        ReadinessConfigSchema.parse({ versions: { shop: { url: "/version" } } }),
        { ...d, get: () => Promise.reject(new Error("down")) },
        sleep,
      ),
    ).toMatchObject({ ready: false, rounds: 1 });
  });

  it("REQ-ENV-13: the configuration refuses scripts outside .qa/hooks, bad targets and a wait longer than its timeout", () => {
    expect(() => ReadinessConfigSchema.parse({ versions: { shop: { command: "../x.sh" } } })).toThrow();
    expect(() => ReadinessConfigSchema.parse({ checks: [{ name: "x", url: "ftp://x" }] })).toThrow();
    expect(() => ReadinessConfigSchema.parse({ wait: { timeout_s: 10, interval_s: 60 } })).toThrow();
  });
});
