import type { AttemptInput } from "@qajitsu/adapter-runner-api";
import { describe, expect, it } from "vitest";
import {
  appiumLocator,
  createAppiumDeviceFactory,
  sourceTexts,
  type AppiumClient,
  type AppiumElement,
} from "./device.js";

const SOURCE = `<hierarchy><android.widget.TextView text="Cart: 1 item" content-desc="cart-count"/><android.widget.Button text="Checkout" content-desc="checkout" enabled="true"/><x text="" /><y text="A &amp; B"/></hierarchy>`;

const fakeClient = () => {
  const calls: string[] = [];
  const element = (sel: string): AppiumElement => ({
    click: () => Promise.resolve(calls.push(`click ${sel}`)),
    setValue: (v) => Promise.resolve(calls.push(`set ${sel}=${v}`)),
    isDisplayed: () => Promise.resolve(sel !== "~gone"),
    isEnabled: () => Promise.resolve(true),
    getAttribute: (n) => Promise.resolve(n === "checked" ? "false" : null),
    getText: () => Promise.resolve(" Cart: 1 item "),
    waitForDisplayed: (o) => {
      calls.push(`wait ${sel}${o.reverse ? " hidden" : ""}`);
      return Promise.resolve(true);
    },
  });
  const client: AppiumClient = {
    $: (sel) => Promise.resolve(element(sel)),
    back: () => Promise.resolve(calls.push("back")),
    execute: (script, args) => Promise.resolve(calls.push(`${script} ${JSON.stringify(args)}`)),
    keys: (k) => Promise.resolve(calls.push(`keys ${String(k)}`)),
    getPageSource: () => Promise.resolve(SOURCE),
    takeScreenshot: () => Promise.resolve(Buffer.from("png").toString("base64")),
    startRecordingScreen: () => Promise.resolve(calls.push("record")),
    stopRecordingScreen: () => Promise.resolve(Buffer.from("mp4").toString("base64")),
    getLogs: (t) => Promise.resolve([{ message: `${t} line token-123` }, "plain"]),
    deleteSession: () => Promise.resolve(calls.push("delete")),
  };
  return { client, calls };
};
const input = { secrets: ["token-123"] } as unknown as AttemptInput;

describe("Appium device driver (REQ-EXEC-06, REQ-EVD-03)", () => {
  it("REQ-EXEC-06/AC1: maps selectors to accessibility ids and UiSelector/predicates; rejects web-only kinds", () => {
    expect(appiumLocator("testid:checkout", "android")).toBe("~checkout");
    expect(appiumLocator("label:Pay", "ios")).toBe("~Pay");
    expect(appiumLocator('text:Say "hi"', "android")).toBe('android=new UiSelector().text("Say \\"hi\\"")');
    expect(appiumLocator("text:Pay", "ios")).toBe('-ios predicate string:label == "Pay" OR value == "Pay"');
    expect(() => appiumLocator("css:#x", "android")).toThrow(/not supported in native apps/);
    expect(() => appiumLocator("role:button", "ios")).toThrow(/testid:, label: or text:/);
    expect(sourceTexts(SOURCE)).toBe("Cart: 1 item\ncart-count\nCheckout\ncheckout\nA & B");
  });

  it("REQ-EXEC-06 + REQ-EVD-03/AC2+AC3: drives the app; recording, masked device logs and page source on failure", async () => {
    const { client, calls } = fakeClient();
    let caps: Record<string, unknown> = {};
    const factory = createAppiumDeviceFactory({
      platform: "android",
      connect: (c) => {
        caps = c;
        return Promise.resolve(client);
      },
      capabilities: { platformName: "Android", "appium:automationName": "UiAutomator2" },
      deepLinkScheme: "demoshop",
      appId: "dev.qajitsu.demoshop",
    });
    const session = factory(input);
    const d = await session.driver();
    await d.goto("http://127.0.0.1:3000/checkout?x=1");
    expect(d.url()).toBe("demoshop://checkout?x=1");
    await d.click("testid:checkout");
    await d.fill("testid:qty", "2");
    await d.check("testid:terms", true);
    await d.press("testid:qty", "Enter");
    await d.waitFor("testid:gone", "hidden");
    await d.back();
    expect(await d.pageText()).toContain("Cart: 1 item");
    expect(await d.property("testid:cart-count", "text")).toBe("Cart: 1 item");
    expect(await d.property("testid:gone", "visible")).toBe(false);
    expect(await d.property("testid:checkout", "enabled")).toBe(true);
    expect(await d.property("testid:terms", "checked")).toBe(false);
    expect(await d.property("testid:x", "value")).toBe("Cart: 1 item");
    expect(new TextDecoder().decode(await d.screenshot(false))).toBe("png");
    expect(await d.dom()).toBe(SOURCE);
    await expect(d.select("testid:x", "a")).rejects.toThrow(/not available/);
    await expect(d.useAccount("user:standard")).rejects.toThrow(/log in through the app/);
    expect(caps).toEqual({ platformName: "Android", "appium:automationName": "UiAutomator2" });
    expect(calls).toContain(
      'mobile: deepLink {"url":"demoshop://checkout?x=1","package":"dev.qajitsu.demoshop","bundleId":"dev.qajitsu.demoshop"}',
    );
    expect(calls).toContain("click ~terms");
    expect(calls).toContain("wait ~gone hidden");
    expect(calls).toContain("back");
    const items = await session.close(true);
    expect(items.map((i) => [i.name, i.kind])).toEqual([
      ["screen.mp4", "video"],
      ["logcat.log", "log"],
      ["page-source.xml", "dom"],
    ]);
    expect(String(items[1]?.content)).toBe("logcat line ***\nplain\n");
    expect(calls.at(-1)).toBe("delete");
    expect(await session.close(false)).toEqual([]);
  });

  it("REQ-EVD-03/AC2: the recording is dropped for a passing case and kept with recording: always; no session, no evidence", async () => {
    const pass = fakeClient();
    const s1 = createAppiumDeviceFactory({
      platform: "ios",
      connect: () => Promise.resolve(pass.client),
      capabilities: {},
    })(input);
    await s1.driver();
    expect((await s1.close(false)).map((i) => i.name)).toEqual(["syslog.log"]);
    const always = fakeClient();
    const s2 = createAppiumDeviceFactory({
      platform: "ios",
      connect: () => Promise.resolve(always.client),
      capabilities: {},
      recording: "always",
    })(input);
    const d = await s2.driver();
    await expect(d.goto("http://127.0.0.1/x")).rejects.toThrow(/deep_link_scheme/);
    expect((await s2.close(false)).map((i) => i.name)).toEqual(["screen.mp4", "syslog.log"]);
    const off = fakeClient();
    const s3 = createAppiumDeviceFactory({
      platform: "android",
      connect: () => Promise.resolve(off.client),
      capabilities: {},
      recording: "off",
    })(input);
    await s3.driver();
    await s3.driver();
    expect(off.calls).not.toContain("record");
    expect(
      await createAppiumDeviceFactory({
        platform: "android",
        connect: () => Promise.resolve(off.client),
        capabilities: {},
      })(input).close(true),
    ).toEqual([]);
  });

  it("stage-8 review: device farm credentials are masked in connection errors", async () => {
    const session = createAppiumDeviceFactory({
      platform: "ios",
      connect: () => Promise.reject(new Error("401 for user farm-user key farm-key-123")),
      capabilities: {},
      secrets: ["farm-key-123", "farm-user"],
    })(input);
    await expect(session.driver()).rejects.toThrow("401 for user *** key ***");
  });

  it("REQ-EVD-08/AC1: element rectangles are scaled to the screenshot's pixels (iOS points); Android stays 1:1", async () => {
    // A screenshot 1170 px wide of a screen 390 points wide: iOS at 3×.
    const shot = Buffer.from([
      137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 146, 0, 0, 9, 216,
    ]);
    const device = async (window?: { width: number; height: number }, exists = true) => {
      const { client } = fakeClient();
      const geometry: AppiumClient = {
        ...client,
        takeScreenshot: () => Promise.resolve(shot.toString("base64")),
        ...(window ? { getWindowSize: () => Promise.resolve(window) } : {}),
        $: async (sel) => ({
          ...(await client.$(sel)),
          isExisting: () => Promise.resolve(exists),
          getLocation: () => Promise.resolve({ x: 10, y: 20 }),
          getSize: () => Promise.resolve({ width: 100, height: 40 }),
        }),
      };
      const factory = createAppiumDeviceFactory({
        platform: window ? "ios" : "android",
        connect: () => Promise.resolve(geometry),
        capabilities: {},
        recording: "off",
      });
      const driver = await factory(input).driver();
      await driver.screenshot(false);
      return driver.bounds?.("testid:pay");
    };
    expect(await device({ width: 390, height: 844 })).toEqual({ x: 30, y: 60, width: 300, height: 120 });
    expect(await device()).toEqual({ x: 10, y: 20, width: 100, height: 40 });
    expect(await device(undefined, false)).toBeUndefined();
  });
});
