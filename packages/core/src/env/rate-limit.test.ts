import { describe, expect, it } from "vitest";
import { RateLimitConfigSchema, createTrafficPolicy, retryAfterMs } from "./rate-limit.js";

/** A clock that only moves when the policy sleeps. */
const clock = () => {
  let now = 0;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: (ms: number) => {
      slept.push(ms);
      now += ms;
      return Promise.resolve();
    },
    slept,
  };
};

describe("shared environments: rate limits (REQ-EXEC-54)", () => {
  it("REQ-EXEC-54/AC1: requests to one host keep to the project's rate, other hosts have their own budget", async () => {
    const c = clock();
    const policy = createTrafficPolicy(RateLimitConfigSchema.parse({ requests_per_second: 2 }), c);
    for (let i = 0; i < 4; i++) await policy.throttle("https://shop.example/api/a");
    await policy.throttle("https://other.example/x");
    // Two at once, then one every 500 ms; the other host waited for nothing.
    expect(c.slept).toEqual([500, 500]);
  });

  it("REQ-EXEC-54/AC1: without a rate nothing waits; parallel cases are capped across lanes", async () => {
    const c = clock();
    const open = createTrafficPolicy(RateLimitConfigSchema.parse({}), c);
    for (let i = 0; i < 20; i++) await open.throttle("https://shop.example/");
    expect(c.slept).toEqual([]);
    const capped = createTrafficPolicy(RateLimitConfigSchema.parse({ parallel_cases: 1 }), c);
    const order: string[] = [];
    const first = await capped.caseSlot();
    const second = capped.caseSlot().then((release) => {
      order.push("second");
      release();
    });
    order.push("first");
    first();
    await second;
    expect(order).toEqual(["first", "second"]);
    expect(createTrafficPolicy(RateLimitConfigSchema.parse({}), c).retryBudgetMs).toBe(30_000);
  });

  it("REQ-EXEC-54/AC2: Retry-After is read as seconds or as an HTTP date; anything else is no wait", () => {
    expect(retryAfterMs({ "retry-after": "3" }, 0)).toBe(3000);
    expect(retryAfterMs({ "Retry-After": "Thu, 01 Jan 1970 00:00:05 GMT" }, 1000)).toBe(4000);
    expect(retryAfterMs({ "retry-after": "soon" }, 0)).toBeUndefined();
    expect(retryAfterMs({ "retry-after": "-1" }, 0)).toBeUndefined();
    expect(retryAfterMs({}, 0)).toBeUndefined();
    expect(retryAfterMs({ "retry-after": "Thu, 01 Jan 1970 00:00:01 GMT" }, 5000)).toBe(0);
  });

  it("REQ-EXEC-54: the settings are bounded", () => {
    expect(() => RateLimitConfigSchema.parse({ requests_per_second: 0 })).toThrow();
    expect(() => RateLimitConfigSchema.parse({ idempotency_header: "bad header" })).toThrow();
    expect(RateLimitConfigSchema.parse({}).idempotency_header).toBe("Idempotency-Key");
  });
});
