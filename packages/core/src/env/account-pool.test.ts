import { describe, expect, it } from "vitest";
import { EnvProfileSchema } from "../config/env-profile.js";
import { accountsUsedBy, createAccountLeases, poolCapacityWarnings } from "./account-pool.js";

const account = (n: number, lanes?: string[]) => ({
  username: `qa${String(n)}@shop.example`,
  password: `secret://env/QA${String(n)}`,
  ...(lanes ? { lanes } : {}),
});

const profile = (accounts: Record<string, unknown>) =>
  EnvProfileSchema.parse({ base_url: "https://staging.shop.example", accounts });

/** A clock the test moves by hand; sleeps resolve when the clock passes their end. */
function manualClock() {
  let now = 0;
  const sleepers: { until: number; done: () => void }[] = [];
  return {
    now: () => now,
    sleep: (ms: number) =>
      new Promise<void>((done) => {
        sleepers.push({ until: now + ms, done });
      }),
    advance: async (ms: number) => {
      now += ms;
      for (const s of sleepers.filter((x) => x.until <= now)) {
        sleepers.splice(sleepers.indexOf(s), 1);
        s.done();
      }
      await new Promise((r) => setImmediate(r));
    },
  };
}

describe("account pools (REQ-ENV-09)", () => {
  it("REQ-ENV-09/AC1: one account is a pool of one; a pool lists its accounts", () => {
    const p = profile({ "user:standard": { pool: [account(1), account(2)] }, "admin:main": account(9) });
    expect(Object.keys(p.accounts)).toEqual(["user:standard", "admin:main"]);
    expect(() => profile({ "user:standard": { pool: [] } })).toThrow();
    expect(() => profile({ "user:standard": { ...account(1), pool: [account(2)] } })).toThrow();
  });

  it("REQ-ENV-09/AC2: cases running at the same time never hold the same account", async () => {
    const clock = manualClock();
    const leases = createAccountLeases(profile({ "user:standard": { pool: [account(1), account(2)] } }), {
      waitMs: 60_000,
      ...clock,
    });
    const a = await leases.acquire({ caseId: "TC-01", lane: "api", aliases: ["user:standard"] });
    const b = await leases.acquire({ caseId: "TC-02", lane: "web", aliases: ["user:standard"] });
    expect([a.members["user:standard"], b.members["user:standard"]].sort()).toEqual([0, 1]);
    expect(a.labels).toEqual({
      "user:standard": `user:standard#${String((a.members["user:standard"] ?? 0) + 1)}`,
    });
    let third: number | undefined;
    const waiting = leases
      .acquire({ caseId: "TC-03", lane: "api", aliases: ["user:standard"] })
      .then((l) => (third = l.members["user:standard"]));
    await clock.advance(1_000);
    expect(third).toBeUndefined();
    b.release();
    await waiting;
    expect(third).toBe(b.members["user:standard"]);
    // Releasing twice gives nothing back twice.
    b.release();
    expect(leases.inUse("user:standard")).toBe(2);
  });

  it("REQ-ENV-09/AC2: a case takes all its aliases at once or waits, so two cases never deadlock", async () => {
    const clock = manualClock();
    const leases = createAccountLeases(
      profile({ "user:a": { pool: [account(1)] }, "user:b": { pool: [account(2)] } }),
      { waitMs: 60_000, ...clock },
    );
    const first = await leases.acquire({ caseId: "TC-01", lane: "api", aliases: ["user:a"] });
    let got = false;
    const second = leases
      .acquire({ caseId: "TC-02", lane: "api", aliases: ["user:b", "user:a"] })
      .then((l) => {
        got = true;
        return l;
      });
    await clock.advance(10);
    // user:b stays free while TC-02 waits for user:a: nothing is held partially.
    expect(got).toBe(false);
    expect(leases.inUse("user:b")).toBe(0);
    first.release();
    expect((await second).members).toEqual({ "user:a": 0, "user:b": 0 });
  });

  it("REQ-ENV-09/AC2: shared aliases are used by several running cases; unknown aliases are not leased", async () => {
    const leases = createAccountLeases(
      profile({ "admin:read": { ...account(9), shared: true }, "user:standard": account(1) }),
      { waitMs: 0 },
    );
    const a = await leases.acquire({ caseId: "TC-01", lane: "api", aliases: ["admin:read", "user:nobody"] });
    const b = await leases.acquire({ caseId: "TC-02", lane: "api", aliases: ["admin:read"] });
    expect(a.members).toEqual({ "admin:read": 0 });
    expect(b.members).toEqual({ "admin:read": 0 });
  });

  it("REQ-ENV-09/AC3: an account limited to a lane is only handed out in that lane", async () => {
    const leases = createAccountLeases(
      profile({ "user:standard": { pool: [account(1, ["mobile"]), account(2)] } }),
      { waitMs: 0 },
    );
    const web = await leases.acquire({ caseId: "TC-01", lane: "web", aliases: ["user:standard"] });
    expect(web.members["user:standard"]).toBe(1);
    web.release();
    const mobile = await leases.acquire({ caseId: "TC-02", lane: "mobile", aliases: ["user:standard"] });
    expect(mobile.members["user:standard"]).toBe(0);
    await expect(
      leases.acquire({ caseId: "TC-03", lane: "web", aliases: ["user:standard"] }),
    ).resolves.toMatchObject({ members: { "user:standard": 1 } });
  });

  it("REQ-ENV-09/AC4: no free account in time is an error with the reason, never an account in use", async () => {
    const clock = manualClock();
    const leases = createAccountLeases(profile({ "user:standard": account(1) }), { waitMs: 5_000, ...clock });
    await leases.acquire({ caseId: "TC-01", lane: "api", aliases: ["user:standard"] });
    const late = expect(
      leases.acquire({ caseId: "TC-02", lane: "api", aliases: ["user:standard"] }),
    ).rejects.toMatchObject({
      code: "ACCOUNT_POOL_EXHAUSTED",
      message: expect.stringContaining("no free account of user:standard within 5 s") as unknown,
    });
    await clock.advance(5_000);
    await late;
    expect(leases.inUse("user:standard")).toBe(1);
    // An alias no account of which may run in the lane fails at once.
    const lanes = createAccountLeases(profile({ "user:m": account(1, ["mobile"]) }), {
      waitMs: 5_000,
      ...clock,
    });
    await expect(lanes.acquire({ caseId: "TC-03", lane: "web", aliases: ["user:m"] })).rejects.toMatchObject({
      code: "ACCOUNT_POOL_EXHAUSTED",
      message: expect.stringContaining("no account of user:m may be used in the web lane") as unknown,
    });
  });

  it("REQ-ENV-09/AC2: the aliases a spec uses are the alias names it mentions", () => {
    const spec = `const u = api.as("user:standard");\nawait ui.as('admin:main');\n// user:other in a comment\n`;
    expect(accountsUsedBy(spec, ["user:standard", "admin:main", "user:other", "user:none"])).toEqual([
      "user:standard",
      "admin:main",
      "user:other",
    ]);
  });

  it("REQ-ENV-09/AC5: env check warns when a pool is smaller than the cases that can need it at once", () => {
    const p = profile({
      "user:standard": { pool: [account(1), account(2)] },
      "user:mobile": { pool: [account(3, ["mobile"])] },
      "admin:read": { ...account(9), shared: true },
    });
    expect(poolCapacityWarnings(p, { api: 2, web: 2, mobile: 3 })).toEqual([
      "user:standard has 2 accounts, up to 7 cases can need it at once (api 2, web 2, mobile 3); the others wait for a free one",
      "user:mobile has 1 account, up to 3 cases can need it at once (mobile 3); the others wait for a free one",
    ]);
    expect(poolCapacityWarnings(p, { api: 1, web: 1, mobile: 0 })).toEqual([]);
  });
});
