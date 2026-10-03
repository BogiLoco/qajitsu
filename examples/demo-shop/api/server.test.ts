import { afterEach, describe, expect, it } from "vitest";
import { startShop } from "./server.mjs";

interface Shop {
  url: string;
  close: () => Promise<void>;
}
const PASSWORD = "fictional-demo-password";
const shops: Shop[] = [];
afterEach(async () => {
  await Promise.all(shops.splice(0).map((s) => s.close()));
});

const start = async (flag?: string): Promise<Shop> => {
  const shop = await startShop({
    env: { DEMO_USER_PASSWORD: PASSWORD, ...(flag ? { [flag]: "1" } : {}) },
  });
  shops.push(shop);
  return shop;
};
const call = async (shop: Shop, method: string, path: string, body?: unknown, token?: string) => {
  const res = await fetch(`${shop.url}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const login = async (shop: Shop, ttl?: number): Promise<string> =>
  String(
    (
      await call(shop, "POST", "/auth/login", {
        username: "standard",
        password: PASSWORD,
        ...(ttl === undefined ? {} : { ttl_seconds: ttl }),
      })
    ).body["token"],
  );

describe("demo-shop seeded bugs (REQ-NFR-04, BUGS.md)", () => {
  it("BUG-01: cart total rounds once without the flag, per line with it", async () => {
    for (const [flag, expected] of [
      [undefined, 1.01],
      ["BUG_CART_TOTAL_ROUNDING", 1.02],
    ] as const) {
      const shop = await start(flag);
      const token = await login(shop);
      await call(shop, "POST", "/cart/lines", { product_id: "P-1", quantity: 3 }, token);
      expect((await call(shop, "GET", "/cart", undefined, token)).body["total"]).toBe(expected);
    }
  });

  it("BUG-02: a negative order quantity is 422 without the flag, 201 with it", async () => {
    for (const [flag, expected] of [
      [undefined, 422],
      ["BUG_ORDER_ACCEPTS_NEGATIVE_QTY", 201],
    ] as const) {
      const shop = await start(flag);
      expect(
        (await call(shop, "POST", "/orders", { product_id: "P-2", quantity: -1 }, await login(shop))).status,
      ).toBe(expected);
    }
  });

  it("BUG-03: an expired token is 401 without the flag, 200 with it", async () => {
    for (const [flag, expected] of [
      [undefined, 401],
      ["BUG_AUTH_EXPIRED_TOKEN_OK", 200],
    ] as const) {
      const shop = await start(flag);
      expect((await call(shop, "GET", "/me", undefined, await login(shop, 0))).status).toBe(expected);
    }
  });

  it("BUG-04: a second code replaces the first without the flag, stacks with it", async () => {
    for (const [flag, expected] of [
      [undefined, ["SAVE20"]],
      ["BUG_DISCOUNT_STACKS", ["SAVE10", "SAVE20"]],
    ] as const) {
      const shop = await start(flag);
      const token = await login(shop);
      await call(shop, "POST", "/cart/lines", { product_id: "P-2", quantity: 1 }, token);
      await call(shop, "POST", "/cart/discount", { code: "SAVE10" }, token);
      expect(
        (await call(shop, "POST", "/cart/discount", { code: "SAVE20" }, token)).body["discounts"],
      ).toEqual(expected);
    }
  });

  it("serves health, version, products; rejects bad logins, unknown codes and routes", async () => {
    const shop = await start();
    expect((await call(shop, "GET", "/health")).body).toEqual({ status: "ok" });
    expect((await call(shop, "GET", "/version")).body).toEqual({ sha: "unknown" });
    expect(((await call(shop, "GET", "/products")).body as unknown as unknown[]).length).toBe(3);
    expect(
      (await call(shop, "POST", "/auth/login", { username: "standard", password: "wrong" })).status,
    ).toBe(401);
    const token = await login(shop);
    expect((await call(shop, "POST", "/cart/discount", { code: "NOPE" }, token)).body).toEqual({
      error: "DISCOUNT_NOT_FOUND",
    });
    expect((await call(shop, "GET", "/nope", undefined, token)).status).toBe(404);
    expect((await call(shop, "GET", "/me")).status).toBe(401);
  });
});
