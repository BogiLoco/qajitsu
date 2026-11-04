/** A fake Appium client for device contracts: one Android screen, every call recorded. */
import type { AppiumClient, AppiumElement } from "@qajitsu/adapter-runner-mobile";

export const APPIUM_SOURCE = `<hierarchy><android.widget.TextView text="Cart: 1 item" content-desc="cart-count"/><android.widget.Button text="Checkout" content-desc="checkout" enabled="true"/><x text="" /><y text="A &amp; B"/></hierarchy>`;

export const fakeAppiumClient = () => {
  const calls: string[] = [];
  // `testid:x` on Android is an XPath over content-desc and resource id; the calls name the id.
  const element = (locator: string): AppiumElement => {
    const sel = /@content-desc="([^"]*)"/.test(locator)
      ? `~${/@content-desc="([^"]*)"/.exec(locator)?.[1] ?? ""}`
      : locator;
    return {
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
    };
  };
  const client: AppiumClient = {
    $: (sel) => Promise.resolve(element(sel)),
    back: () => Promise.resolve(calls.push("back")),
    execute: (script, args) => Promise.resolve(calls.push(`${script} ${JSON.stringify(args)}`)),
    keys: (k) => Promise.resolve(calls.push(`keys ${String(k)}`)),
    getPageSource: () => Promise.resolve(APPIUM_SOURCE),
    takeScreenshot: () => Promise.resolve(Buffer.from("png").toString("base64")),
    startRecordingScreen: () => Promise.resolve(calls.push("record")),
    stopRecordingScreen: () => Promise.resolve(Buffer.from("mp4").toString("base64")),
    getLogs: (t) => Promise.resolve([{ message: `${t} line token-123` }, "plain"]),
    deleteSession: () => Promise.resolve(calls.push("delete")),
  };
  return { client, calls };
};
