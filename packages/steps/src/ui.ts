import type { ScreenBox } from "@qajitsu/core";
/** Element selector of a spec: `testid:<id>`, `role:<role>[:<name>]`, `label:<text>`, `text:<text>` or `css:<selector>`. */
export type UiSelector = string;

/** Element properties a plan can expect and the parent can read (REQ-EXEC-05). */
export type UiProperty = "visible" | "enabled" | "checked" | "text" | "value";

/** Browser driven by the trusted parent (ADR-0004). Implemented by `runner-web` on Playwright. */
export interface UiDriver {
  readonly goto: (url: string) => Promise<void>;
  readonly click: (selector: UiSelector) => Promise<void>;
  readonly fill: (selector: UiSelector, value: string) => Promise<void>;
  readonly check: (selector: UiSelector, checked: boolean) => Promise<void>;
  readonly select: (selector: UiSelector, value: string) => Promise<void>;
  readonly press: (selector: UiSelector, key: string) => Promise<void>;
  readonly waitFor: (selector: UiSelector, state: "visible" | "hidden") => Promise<void>;
  /** Browser history back; on Android the system back button (REQ-EXEC-06). */
  readonly back: () => Promise<void>;
  /** Visible text of the page body. */
  readonly pageText: () => Promise<string>;
  /** Current URL. */
  readonly url: () => string;
  readonly property: (selector: UiSelector, property: UiProperty) => Promise<unknown>;
  /** Starts a session as an account (storage set by the framework, never typed by a spec; REQ-CFG-07). */
  readonly useAccount: (alias: string) => Promise<void>;
  /** A PNG of the page; `masks` paints over changing regions (REQ-EXEC-12/AC1; ignored on mobile). */
  readonly screenshot: (fullPage: boolean, masks?: readonly UiSelector[]) => Promise<Uint8Array>;
  readonly dom: () => Promise<string>;
  /** Where an element is on the screenshot, in its pixels; undefined when it is not on the screen (REQ-EVD-08). */
  readonly bounds?: (selector: UiSelector) => Promise<ScreenBox | undefined>;
}

/** The browser API a spec sees (the parent performs every action). */
export interface UiClient {
  readonly goto: (path: string) => Promise<void>;
  readonly click: (selector: UiSelector) => Promise<void>;
  readonly fill: (selector: UiSelector, value: string) => Promise<void>;
  readonly check: (selector: UiSelector) => Promise<void>;
  readonly uncheck: (selector: UiSelector) => Promise<void>;
  readonly select: (selector: UiSelector, value: string) => Promise<void>;
  readonly press: (selector: UiSelector, key: string) => Promise<void>;
  readonly waitFor: (selector: UiSelector, state?: "visible" | "hidden") => Promise<void>;
  /** Goes back: browser history, or the Android back button in mobile cases. */
  readonly back: () => Promise<void>;
  /** Opens the app as an account alias, e.g. `user:standard`. */
  readonly as: (alias: string) => Promise<void>;
}

/** UI operations sent from a spec to the parent. */
export type UiOperation =
  | { readonly op: "goto"; readonly path: string }
  | { readonly op: "click" | "check" | "uncheck"; readonly selector: UiSelector }
  | { readonly op: "fill" | "select" | "press"; readonly selector: UiSelector; readonly value: string }
  | { readonly op: "waitFor"; readonly selector: UiSelector; readonly state: "visible" | "hidden" }
  | { readonly op: "back" }
  | { readonly op: "as"; readonly alias: string };

const SELECTOR = /^(testid|role|label|text|css):.+$/;

/**
 * Validates a selector string.
 *
 * @throws {Error} For anything that is not a known selector kind.
 */
export function assertSelector(selector: string): UiSelector {
  if (!SELECTOR.test(selector) || selector.length > 300)
    throw new Error(`Invalid selector '${selector.slice(0, 60)}': use testid:, role:, label:, text: or css:`);
  return selector;
}
