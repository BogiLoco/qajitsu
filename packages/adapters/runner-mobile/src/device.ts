import type { AttemptInput, BrowserFactory, BrowserSession } from "@qajitsu/adapter-runner-api";
import { createMasker, type EvidenceItem, type UiDriver, type UiProperty } from "@qajitsu/steps";

/** The part of a WebdriverIO element the driver uses. */
export interface AppiumElement {
  click(): Promise<unknown>;
  setValue(value: string): Promise<unknown>;
  isDisplayed(): Promise<boolean>;
  isEnabled(): Promise<boolean>;
  getAttribute(name: string): Promise<string | null>;
  getText(): Promise<string>;
  waitForDisplayed(options: { timeout?: number; reverse?: boolean }): Promise<unknown>;
  /** Position and size on the screen, for marking a failed element (REQ-EVD-08). */
  isExisting?(): Promise<boolean>;
  getLocation?(): Promise<{ x: number; y: number }>;
  getSize?(): Promise<{ width: number; height: number }>;
}

/** The part of a WebdriverIO session the driver uses (an Appium session in production). */
export interface AppiumClient {
  $(selector: string): Promise<AppiumElement>;
  back(): Promise<unknown>;
  execute(script: string, ...args: unknown[]): Promise<unknown>;
  keys(value: string | string[]): Promise<unknown>;
  getPageSource(): Promise<string>;
  takeScreenshot(): Promise<string>;
  startRecordingScreen(): Promise<unknown>;
  stopRecordingScreen(): Promise<string>;
  getLogs(type: string): Promise<unknown[]>;
  deleteSession(): Promise<unknown>;
}

/** Settings of the mobile runner (REQ-EXEC-06, REQ-EVD-03). */
export interface MobileRunnerOptions {
  readonly platform: "android" | "ios";
  /** Opens a session on the Appium server (or a device farm hub) with these capabilities. */
  readonly connect: (capabilities: Record<string, unknown>) => Promise<AppiumClient>;
  /** W3C capabilities: app, device, automation name; secrets never go here (invariant 8). */
  readonly capabilities: Readonly<Record<string, unknown>>;
  /** Screen recording per case (REQ-EVD-03/AC2). */
  readonly recording?: "retain-on-failure" | "always" | "off";
  /** URL scheme of the app's deep links; `ui.goto("/cart")` opens `<scheme>://cart`. */
  readonly deepLinkScheme?: string | undefined;
  /** Android package or iOS bundle id, for deep links. */
  readonly appId?: string | undefined;
  readonly actionTimeoutMs?: number;
  /** Extra values to mask in device logs, page source and errors (device farm credentials). */
  readonly secrets?: readonly string[];
}

/**
 * Maps a spec selector to an Appium locator: `testid:` and `label:` are accessibility ids (Android
 * content-desc, iOS accessibilityIdentifier/label), `text:` is the visible text. `role:` and `css:`
 * do not exist in native apps.
 *
 * @throws {Error} For selector kinds a native app cannot resolve.
 */
export function appiumLocator(selector: string, platform: "android" | "ios"): string {
  const colon = selector.indexOf(":");
  const kind = selector.slice(0, colon);
  const value = selector.slice(colon + 1);
  const quoted = JSON.stringify(value);
  switch (kind) {
    case "testid":
    case "label":
      return `~${value}`;
    case "text":
      return platform === "android"
        ? `android=new UiSelector().text(${quoted})`
        : `-ios predicate string:label == ${quoted} OR value == ${quoted}`;
    default:
      throw new Error(
        `Selector '${selector.slice(0, 60)}' is not supported in native apps: use testid:, label: or text:`,
      );
  }
}

/** Visible texts of an Appium page source (Android `text`/`content-desc`, iOS `label`/`value`). */
export function sourceTexts(source: string): string {
  const texts = [...source.matchAll(/\s(?:text|content-desc|label|value)="([^"]*)"/g)]
    .map((m) =>
      (m[1] ?? "")
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">"),
    )
    .filter((t) => t.trim() !== "");
  return [...new Set(texts)].join("\n");
}

const base64 = (text: string): Uint8Array => new Uint8Array(Buffer.from(text, "base64"));

/**
 * Creates the device session factory for mobile cases (REQ-EXEC-06): the trusted parent drives the app
 * through Appium exactly as it drives a browser for web cases (ADR-0004); the sandboxed spec only sends
 * `ui.*` operations. Evidence: a screenshot after every step comes from the steps runtime; this adds a
 * screen recording, device logs and, on failure, the page source (REQ-EVD-03).
 *
 * @param options - Platform, Appium connection, capabilities and evidence settings.
 */
export function createAppiumDeviceFactory(options: MobileRunnerOptions): BrowserFactory {
  const recording = options.recording ?? "retain-on-failure";
  const timeout = options.actionTimeoutMs ?? 10_000;
  return (input: AttemptInput): BrowserSession => {
    const masker = createMasker({ secrets: [...input.secrets, ...(options.secrets ?? [])] });
    let client: AppiumClient | undefined;
    let current = "app:launch";
    const start = async (): Promise<UiDriver> => {
      if (!client) {
        client = await options.connect({ ...options.capabilities }).catch((error: unknown) => {
          throw new Error(masker.maskText(error instanceof Error ? error.message : String(error)));
        });
        if (recording !== "off") await client.startRecordingScreen().catch(() => undefined);
      }
      const c = client;
      const find = async (selector: string): Promise<AppiumElement> => {
        const el = await c.$(appiumLocator(selector, options.platform));
        await el.waitForDisplayed({ timeout });
        return el;
      };
      return {
        goto: async (url) => {
          if (!options.deepLinkScheme)
            throw new Error("ui.goto needs mobile.deep_link_scheme for native apps");
          const target = new URL(url);
          const link = `${options.deepLinkScheme}://${`${target.pathname}${target.search}`.replace(/^\//, "")}`;
          await c.execute("mobile: deepLink", { url: link, package: options.appId, bundleId: options.appId });
          current = link;
        },
        click: async (s) => {
          await (await find(s)).click();
        },
        fill: async (s, v) => {
          await (await find(s)).setValue(v);
        },
        check: async (s, checked) => {
          const el = await find(s);
          if (((await el.getAttribute("checked")) === "true") !== checked) await el.click();
        },
        select: () => Promise.reject(new Error("ui.select is not available in native apps")),
        press: async (s, key) => {
          await find(s);
          await c.keys(key);
        },
        waitFor: async (s, state) => {
          const el = await c.$(appiumLocator(s, options.platform));
          await el.waitForDisplayed({ timeout, reverse: state === "hidden" });
        },
        back: async () => {
          await c.back();
        },
        pageText: async () => sourceTexts(await c.getPageSource()),
        url: () => current,
        property: async (s, property: UiProperty) => {
          const el = await c.$(appiumLocator(s, options.platform));
          switch (property) {
            case "visible":
              return el.isDisplayed().catch(() => false);
            case "enabled":
              return el.isEnabled();
            case "checked":
              return (await el.getAttribute("checked")) === "true";
            case "text":
            case "value":
              return (await el.getText()).trim();
          }
        },
        useAccount: () =>
          Promise.reject(
            new Error("ui.as is not available in native apps: log in through the app's own screens"),
          ),
        screenshot: async () => base64(await c.takeScreenshot()),
        dom: () => c.getPageSource(),
        // REQ-EVD-08: the element's rectangle in screen pixels, as on the screenshot.
        bounds: async (s) => {
          const el = await c.$(appiumLocator(s, options.platform));
          if (!el.getLocation || !el.getSize || !(await el.isExisting?.().catch(() => false)))
            return undefined;
          const [at, size] = await Promise.all([el.getLocation(), el.getSize()]).catch(() => [
            undefined,
            undefined,
          ]);
          return at && size ? { x: at.x, y: at.y, width: size.width, height: size.height } : undefined;
        },
      };
    };
    return {
      driver: start,
      close: async (failed) => {
        if (!client) return [];
        const c = client;
        client = undefined;
        const items: EvidenceItem[] = [];
        try {
          if (recording !== "off") {
            const video = await c.stopRecordingScreen().catch(() => "");
            if (video !== "" && (recording === "always" || failed))
              items.push({ stepId: "case", kind: "video", name: "screen.mp4", content: base64(video) });
          }
          // REQ-EVD-03/AC3: device logs and the page source of the failing screen.
          const logType = options.platform === "android" ? "logcat" : "syslog";
          const logs = await c.getLogs(logType).catch(() => [] as unknown[]);
          const lines = logs.map((l) =>
            typeof l === "object" && l !== null && "message" in l ? String(l.message) : String(l),
          );
          items.push({
            stepId: "case",
            kind: "log",
            name: `${logType}.log`,
            content: masker.maskText(`${lines.join("\n")}\n`),
          });
          if (failed)
            items.push({
              stepId: "case",
              kind: "dom",
              name: "page-source.xml",
              content: masker.maskText(await c.getPageSource().catch(() => "")),
            });
        } finally {
          await c.deleteSession().catch(() => undefined);
        }
        return items;
      },
    };
  };
}
