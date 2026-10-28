import type { BrowserLoginFlow, BrowserState } from "@qajitsu/core";
import { chromium, firefox, webkit } from "playwright-core";
import { locate } from "./browser.js";

/** Options of {@link createBrowserLogin}. */
export interface BrowserLoginOptions {
  readonly browser?: "chromium" | "firefox" | "webkit";
  readonly headless?: boolean;
}

/**
 * The browser login of REQ-EXEC-55/AC2: QAJitsu opens the application's login, goes through the identity provider's
 * pages as the profile describes, and returns the cookies and `localStorage` the application set for its own origin.
 * Every page it loads must be allowed (INV-10); errors name the step, never a typed value.
 *
 * @param options - Browser engine and whether to show it.
 */
export function createBrowserLogin(options: BrowserLoginOptions = {}) {
  return async (
    flow: BrowserLoginFlow,
    values: { readonly username: string; readonly password: string; readonly totp?: () => string },
    where: { readonly baseUrl: string; readonly allowedOrigins: readonly string[] },
  ): Promise<BrowserState> => {
    const type = options.browser === "firefox" ? firefox : options.browser === "webkit" ? webkit : chromium;
    const browser = await type.launch({ headless: options.headless ?? true });
    try {
      const context = await browser.newContext({ baseURL: where.baseUrl });
      context.setDefaultTimeout(flow.timeout_s * 1000);
      let refused: string | undefined;
      await context.route("**/*", (route) => {
        const url = route.request().url();
        const origin = /^(data|blob|about):/.test(url) ? "local" : new URL(url).origin;
        if (origin === "local" || where.allowedOrigins.includes(origin)) {
          void route.continue();
          return;
        }
        if (route.request().isNavigationRequest()) refused = origin;
        void route.abort("blockedbyclient");
      });
      const page = await context.newPage();
      const fill = (template: string): string =>
        template.replace(/\{\{(username|password|totp)\}\}/g, (_, name: string) => {
          if (name === "username") return values.username;
          if (name === "password") return values.password;
          if (!values.totp) throw new Error("the flow types {{totp}} but the account has no TOTP seed");
          return values.totp();
        });
      await page.goto(flow.start);
      for (const [i, step] of flow.steps.entries()) {
        try {
          if ("fill" in step) await locate(page, step.fill).fill(fill(step.value));
          else if ("click" in step) await locate(page, step.click).click();
          else if ("press" in step) await locate(page, step.press).press(step.key);
          else await locate(page, step.wait_for).waitFor({ state: "visible" });
        } catch (error) {
          const why = refused
            ? `the page went to ${refused}, which is not allowed for this login`
            : error instanceof Error
              ? error.message.split("\n")[0]?.slice(0, 120)
              : "error";
          throw new Error(`step ${String(i + 1)} of the login failed: ${why ?? "error"}`, { cause: error });
        }
      }
      const origin = new URL(where.baseUrl).origin;
      if (flow.done.path !== undefined) {
        const path = flow.done.path;
        await page
          .waitForURL((u) => u.origin === origin && u.pathname.startsWith(path))
          .catch(() => {
            throw new Error(
              refused
                ? `the page went to ${refused}, which is not allowed for this login`
                : `the login did not come back to ${path}`,
            );
          });
      }
      if (flow.done.selector !== undefined)
        await locate(page, flow.done.selector)
          .waitFor({ state: "visible" })
          .catch(() => {
            throw new Error(`the login did not show ${flow.done.selector ?? ""}`);
          });
      const state = await context.storageState();
      const host = new URL(origin).hostname;
      // Only the application's own session: the identity provider's cookies stay behind.
      const cookies = state.cookies
        .filter((c) => c.domain.replace(/^\./, "") === host)
        .map((c) => ({
          name: c.name,
          value: c.value,
          path: c.path,
          httpOnly: c.httpOnly,
          secure: c.secure,
          sameSite: c.sameSite,
          ...(c.expires > 0 ? { expires: c.expires } : {}),
        }));
      const storage = Object.fromEntries(
        (state.origins.find((o) => o.origin === origin)?.localStorage ?? []).map((e) => [e.name, e.value]),
      );
      return { cookies, ...(Object.keys(storage).length > 0 ? { localStorage: storage } : {}) };
    } finally {
      await browser.close();
    }
  };
}
