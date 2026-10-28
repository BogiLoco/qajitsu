import { afterEach, describe, expect, it } from "vitest";
import { startIdp } from "../../../../examples/demo-shop/api/idp.mjs";
import { startShop } from "../../../../examples/demo-shop/api/server.mjs";
import { createBrowserLogin } from "./browser-login.js";

const PASSWORD = "fictional-demo-password";
/** A fictional authenticator seed of the demo user. */
const SEED = "JBSWY3DPEHPK3PXP";
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const flow = (allow: string[]) => ({
  start: "/sso/start",
  steps: [
    { fill: "label:Username", value: "{{username}}" },
    { fill: "label:Password", value: "{{password}}" },
    { fill: "label:Code", value: "{{totp}}" },
    { click: "role:button:Sign in" },
  ],
  done: { path: "/app/account", selector: "testid:account-user >> has-text:Signed in" },
  allow,
  timeout_s: 15,
  reuse: true,
});

const setup = async () => {
  const idp = await startIdp({ password: PASSWORD, totpSeed: SEED });
  cleanups.push(() => idp.close());
  const shop = await startShop({ env: { DEMO_USER_PASSWORD: PASSWORD }, idpUrl: idp.url });
  cleanups.push(() => shop.close());
  return { idp, shop };
};

describe("SSO login through the browser (REQ-EXEC-55/AC2)", () => {
  it("REQ-EXEC-55/AC1+AC2: password and a TOTP code on the provider's page give the application's own session", async () => {
    const { idp, shop } = await setup();
    const { totp } = await import("@qajitsu/core");
    const state = await createBrowserLogin()(
      flow([idp.url]),
      { username: "standard", password: PASSWORD, totp: () => totp(SEED, Date.now()) },
      { baseUrl: shop.url, allowedOrigins: [shop.url, idp.url] },
    );
    expect(state.cookies.map((c) => [c.name, c.httpOnly])).toEqual([["sid", true]]);
    const me = await fetch(`${shop.url}/me`, { headers: { cookie: `sid=${state.cookies[0]?.value ?? ""}` } });
    expect(await me.json()).toEqual({ username: "standard" });
  }, 60_000);

  it("REQ-EXEC-55/AC2 + INV-10: a provider outside the allowlist stops the login with its origin named; a wrong code fails", async () => {
    const { idp, shop } = await setup();
    const refused = await createBrowserLogin()(
      flow([]),
      { username: "standard", password: PASSWORD, totp: () => "000000" },
      { baseUrl: shop.url, allowedOrigins: [shop.url] },
    ).catch((e: unknown) => (e instanceof Error ? e.message : ""));
    expect(refused).toContain(`the page went to ${idp.url}, which is not allowed for this login`);
    const wrong = await createBrowserLogin()(
      { ...flow([idp.url]), timeout_s: 5 },
      { username: "standard", password: PASSWORD, totp: () => "000000" },
      { baseUrl: shop.url, allowedOrigins: [shop.url, idp.url] },
    ).catch((e: unknown) => (e instanceof Error ? e.message : ""));
    expect(wrong).toBe("the login did not come back to /app/account");
    expect(wrong).not.toContain(PASSWORD);
  }, 60_000);
});
