import type { ScreenBox, UiElementFact } from "@qajitsu/core";
/**
 * Width and height of a PNG from its header, without decoding it; undefined when the bytes are not a PNG.
 *
 * @param png - PNG bytes.
 */
export function pngDimensions(png: Uint8Array): { width: number; height: number } | undefined {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (png.length < 24 || signature.some((b, i) => png[i] !== b)) return undefined;
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

/**
 * Element selector of a spec: `testid:<id>`, `role:<role>[:<name>]`, `label:<text>`, `placeholder:<text>`,
 * `alt:<text>`, `title:<text>`, `text:<text>`, `id:<id>`, `css:<selector>` or `xpath:<path>` (REQ-EXEC-21/AC3).
 */
export type UiSelector = string;

/** Element properties a plan can expect and the parent can read (REQ-EXEC-05, REQ-EXEC-40/AC2). */
export type UiProperty = "visible" | "enabled" | "checked" | "text" | "value" | "in_viewport";

/** A file the parent gives an upload (REQ-EXEC-38/AC1), resolved from the plan, never from the spec. */
export interface UiFile {
  readonly name: string;
  readonly type: string;
  readonly data: Uint8Array;
}

/** A file a step downloaded (REQ-EXEC-38/AC2). */
export interface UiDownload {
  /** The name the application suggested. */
  readonly name: string;
  readonly data: Uint8Array;
}

/** Which page of the case actions go to (REQ-EXEC-39/AC2). */
export interface UiPageRef {
  /** 0 is the first page of the case; pop-ups and new tabs count up. */
  readonly index: number;
  readonly url: string;
}

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
  /** The elements on the page or screen now, for snapshots of the trusted parent (REQ-EXEC-22/AC1). */
  readonly elements?: () => Promise<readonly UiElementFact[]>;
  // Web actions (REQ-EXEC-38..40, ADR-0013); a driver without one refuses the action.
  readonly pointer?: (selector: UiSelector, kind: "hover" | "dblclick" | "rightclick") => Promise<void>;
  readonly dragTo?: (source: UiSelector, target: UiSelector) => Promise<void>;
  readonly dragBy?: (selector: UiSelector, dx: number, dy: number) => Promise<void>;
  /** A key or combination for the focused element or the page, e.g. `Control+A`. */
  readonly keys?: (combination: string) => Promise<void>;
  readonly scrollTo?: (selector: UiSelector) => Promise<void>;
  readonly scrollBy?: (dx: number, dy: number) => Promise<void>;
  /** Scrolls down until the element is visible, at most `limit` times; returns how often it scrolled. */
  readonly scrollUntil?: (
    selector: UiSelector,
    limit: number,
  ) => Promise<{ scrolls: number; found: boolean; y: number }>;
  /** Puts files into a file input, or drops them on a drop zone. */
  readonly upload?: (selector: UiSelector, files: readonly UiFile[]) => Promise<void>;
  /** Clicks the element and waits for the download it starts. */
  readonly download?: (selector: UiSelector, timeoutMs: number) => Promise<UiDownload>;
  /** Actions go to the newest page opened after the current one, or back to the page that opened it. */
  readonly switchPage?: (to: "new" | "opener", timeoutMs: number) => Promise<UiPageRef>;
  /** Closes the current page and returns to its opener. */
  readonly closePage?: () => Promise<UiPageRef>;
  /** The page actions go to now. */
  readonly currentPage?: () => UiPageRef;
  /** A value of the application's test hook by path (REQ-EXEC-56/AC2); undefined when the hook has none. */
  readonly testState?: (
    hook: string,
    path: string,
  ) => Promise<{ readonly hook: boolean; readonly value: unknown }>;
  /** A PNG of one element (a canvas, a chart) for a visual check (REQ-EXEC-56/AC2). */
  readonly elementScreenshot?: (selector: UiSelector) => Promise<Uint8Array>;
  /** How browser dialogs of the current step are answered (REQ-EXEC-61/AC1); undefined dismisses them. */
  readonly setDialogPolicy?: (
    policy: { readonly action: "accept" | "dismiss"; readonly text?: string | undefined } | undefined,
  ) => void;
  /** The dialogs shown since the last call, with how they were answered. */
  readonly takeDialogs?: () => readonly {
    readonly type: string;
    readonly message: string;
    readonly answer: string;
  }[];
  /** Moves the browser's clock forward (REQ-EXEC-61/AC2), firing timers that fall due. */
  readonly advanceTime?: (ms: number) => Promise<void>;
  /** Why an element cannot be reached, when the page explains it (a closed shadow root, REQ-EXEC-56/AC1). */
  readonly unreachableReason?: () => Promise<string | undefined>;
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
  readonly hover: (selector: UiSelector) => Promise<void>;
  readonly dblclick: (selector: UiSelector) => Promise<void>;
  readonly rightClick: (selector: UiSelector) => Promise<void>;
  /** Drags an element onto another one. */
  readonly dragTo: (source: UiSelector, target: UiSelector) => Promise<void>;
  /** Drags an element by an offset in pixels. */
  readonly dragBy: (selector: UiSelector, dx: number, dy: number) => Promise<void>;
  /** A key or combination for the page, e.g. `Control+A` or `Escape`. */
  readonly keys: (combination: string) => Promise<void>;
  readonly scrollTo: (selector: UiSelector) => Promise<void>;
  readonly scrollBy: (dx: number, dy: number) => Promise<void>;
  /** Scrolls until the element appears (infinite lists), at most the step's `scroll_limit` times. */
  readonly scrollUntil: (selector: UiSelector) => Promise<void>;
  /** Uploads the case's files by their plan keys (`files` of the case). */
  readonly upload: (selector: UiSelector, ...files: string[]) => Promise<void>;
  /** Clicks the element and keeps the file it downloads; checked with `download.*`. */
  readonly download: (selector: UiSelector) => Promise<void>;
  /** Actions go to the pop-up or tab the last action opened. */
  readonly switchToNewPage: () => Promise<void>;
  /** Actions go back to the page that opened the current one. */
  readonly switchToOpener: () => Promise<void>;
  /** Closes the current pop-up or tab; actions go back to its opener. */
  readonly closePage: () => Promise<void>;
  /** Moves the page's clock forward by seconds (countdowns, expiring offers; REQ-EXEC-61/AC2). */
  readonly advanceTime: (seconds: number) => Promise<void>;
}

/** UI operations sent from a spec to the parent. */
export type UiOperation =
  | { readonly op: "goto"; readonly path: string }
  | { readonly op: "click" | "check" | "uncheck"; readonly selector: UiSelector }
  | { readonly op: "fill" | "select" | "press"; readonly selector: UiSelector; readonly value: string }
  | { readonly op: "waitFor"; readonly selector: UiSelector; readonly state: "visible" | "hidden" }
  | { readonly op: "back" }
  | { readonly op: "as"; readonly alias: string }
  | {
      readonly op: "hover" | "dblclick" | "rightclick" | "scrollTo" | "scrollUntil" | "download";
      readonly selector: UiSelector;
    }
  | { readonly op: "dragTo"; readonly selector: UiSelector; readonly target: UiSelector }
  | { readonly op: "dragBy"; readonly selector: UiSelector; readonly dx: number; readonly dy: number }
  | { readonly op: "scrollBy"; readonly dx: number; readonly dy: number }
  | { readonly op: "keys"; readonly value: string }
  | { readonly op: "upload"; readonly selector: UiSelector; readonly files: readonly string[] }
  | { readonly op: "switchPage"; readonly to: "new" | "opener" }
  | { readonly op: "closePage" }
  | { readonly op: "advanceTime"; readonly seconds: number };

/**
 * Selector kinds, the most stable first (REQ-EXEC-21/AC3). The web resolves testid, role, label, text, placeholder,
 * alt, title, id and css; a native app testid (accessibility id or resource id), label, text, id (resource id) and
 * xpath. The runner of each platform rejects the others.
 */
export const SELECTOR_KINDS = [
  "testid",
  "role",
  "label",
  "placeholder",
  "alt",
  "title",
  "text",
  "id",
  "css",
  "xpath",
] as const;

const SELECTOR = new RegExp(`^(${SELECTOR_KINDS.join("|")}):.+$`);
/** A frame of a frame chain: the iframe element found by test id, title, id or CSS (REQ-EXEC-39/AC1). */
const FRAME = /^frame:(testid|title|id|css):.+$/;

/** The frames of a selector and the element inside the innermost one: `frame:title:Pay >> testid:card`. */
export function splitFrames(selector: UiSelector): {
  readonly frames: readonly string[];
  readonly element: string;
} {
  const parts = selector.split(" >> ");
  return { frames: parts.slice(0, -1).map((p) => p.slice("frame:".length)), element: parts.at(-1) ?? "" };
}

/** One part of a selector chain (REQ-EXEC-39, REQ-EXEC-64). */
export type SelectorPart =
  | { readonly kind: "frame"; readonly selector: string }
  | { readonly kind: "element"; readonly selector: string }
  | { readonly kind: "hasText"; readonly text: string }
  | { readonly kind: "nth"; readonly n: number };

const HAS_TEXT = /^has-text:(.+)$/;
const NTH = /^nth:([1-9]\d{0,2})$/;

/**
 * The parts of a selector chain: `frame:<selector>` enters an iframe, an element selector searches inside what the
 * previous part found, `has-text:<text>` keeps the matches containing that text and `nth:<n>` the n-th match
 * (1 is the first). For example `role:row >> has-text:Anna Smith >> role:button:Delete`.
 */
export function selectorParts(selector: UiSelector): readonly SelectorPart[] {
  return selector.split(" >> ").map((p): SelectorPart => {
    if (FRAME.test(p)) return { kind: "frame", selector: p.slice("frame:".length) };
    const t = HAS_TEXT.exec(p);
    if (t) return { kind: "hasText", text: t[1] ?? "" };
    const n = NTH.exec(p);
    if (n) return { kind: "nth", n: Number(n[1]) };
    return { kind: "element", selector: p };
  });
}

/**
 * Validates a selector: a known kind, optionally a chain (` >> `) of frames, elements inside elements, and the filters
 * `has-text:` and `nth:` after an element (REQ-EXEC-39, REQ-EXEC-64); at most 8 parts and 300 characters.
 *
 * @throws {Error} For anything that is not a known selector kind or a valid chain.
 */
export function assertSelector(selector: string): UiSelector {
  const raw = selector.split(" >> ");
  const parts = selectorParts(selector);
  const ok =
    selector.length <= 300 &&
    raw.length <= 8 &&
    parts.every((p, i) => {
      if (p.kind === "element") return SELECTOR.test(raw[i] ?? "");
      if (p.kind === "frame") return i < parts.length - 1;
      // A filter narrows the element right before it (or before another filter).
      const before = parts[i - 1];
      return before !== undefined && before.kind !== "frame";
    }) &&
    parts.at(-1)?.kind !== "frame";
  if (!ok)
    throw new Error(
      `Invalid selector '${selector.slice(0, 60)}': use ${SELECTOR_KINDS.map((k) => `${k}:`).join(", ")}, chained with ' >> ' (frame:, has-text:, nth:)`,
    );
  return selector;
}
