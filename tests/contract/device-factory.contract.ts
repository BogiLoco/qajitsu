import type { AttemptInput, BrowserFactory } from "@qajitsu/adapter-runner-api";
import type { AppiumClient } from "@qajitsu/adapter-runner-mobile";
import { describe, expect, it } from "vitest";
import { fakeAppiumClient } from "../support/fake-appium.js";

/** How the contract builds a device factory: the mobile runner's `createAppiumDeviceFactory` for Android. */
export type CreateDeviceFactory = (options: {
  readonly platform: "android";
  readonly connect: (caps: Record<string, unknown>) => Promise<AppiumClient>;
  readonly capabilities: Record<string, unknown>;
  readonly deepLinkScheme: string;
  readonly appId: string;
}) => BrowserFactory;

/**
 * Contract of the mobile runner's device factory (REQ-EXEC-06, REQ-EVD-03, REQ-GEN-11/AC11) on a fake Appium client:
 * the trusted parent drives the app through the device and reads element state from it, and a failed case leaves the
 * recording, the masked device log and the page source as evidence.
 *
 * @param name - The factory under test.
 * @param create - Gives the factory function (from the source or the installed plugin).
 */
export function deviceFactoryContract(name: string, create: () => Promise<CreateDeviceFactory>): void {
  describe(`device factory contract: ${name}`, () => {
    it("REQ-EXEC-06/AC1 + REQ-EVD-03/AC2+AC3: drives the app, reads its state and keeps masked evidence of a failure", async () => {
      const { client, calls } = fakeAppiumClient();
      const factory = (await create())({
        platform: "android",
        connect: () => Promise.resolve(client),
        capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2" },
        deepLinkScheme: "demoshop",
        appId: "dev.qajitsu.demoshop",
      });
      const session = factory({ secrets: ["token-123"] } as unknown as AttemptInput);
      const d = await session.driver();
      await d.click("testid:checkout");
      expect(await d.property("testid:cart-count", "text")).toBe("Cart: 1 item");
      expect(await d.property("testid:checkout", "enabled")).toBe(true);
      expect(calls).toContain("click ~checkout");
      const items = await session.close(true);
      expect(items.map((i) => i.kind)).toEqual(["video", "log", "dom"]);
      expect(String(items[1]?.content)).not.toContain("token-123");
      expect(calls.at(-1)).toBe("delete");
    });
  });
}
