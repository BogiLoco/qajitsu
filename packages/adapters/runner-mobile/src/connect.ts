import { remote } from "webdriverio";
import type { AppiumClient } from "./device.js";

/**
 * Opens a WebdriverIO session on an Appium server or a device farm hub (REQ-EXEC-06/AC1).
 *
 * @param url - Server URL, e.g. `http://127.0.0.1:4723` or `https://hub.browserstack.com/wd/hub`.
 * @param capabilities - W3C capabilities.
 * @param auth - Hub credentials for device farms, resolved from the secret provider.
 */
export async function connectAppium(
  url: string,
  capabilities: Record<string, unknown>,
  auth?: { readonly user: string; readonly key: string },
): Promise<AppiumClient> {
  const u = new URL(url);
  const session = await remote({
    protocol: u.protocol === "https:" ? "https" : "http",
    hostname: u.hostname,
    port: Number(u.port || (u.protocol === "https:" ? 443 : 80)),
    path: u.pathname === "" ? "/" : u.pathname,
    logLevel: "silent",
    capabilities,
    ...(auth ? { user: auth.user, key: auth.key } : {}),
  });
  // WebdriverIO's element API is chainable; the driver only needs the awaited subset.
  return session as unknown as AppiumClient;
}
