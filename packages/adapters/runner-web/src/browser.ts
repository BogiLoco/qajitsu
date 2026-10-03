import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AttemptInput, BrowserFactory, BrowserSession } from "@qajitsu/adapter-runner-api";
import {
  createMasker,
  DEFAULT_SENSITIVE_HEADERS,
  MASK,
  type EvidenceItem,
  type UiDriver,
  type UiProperty,
} from "@qajitsu/steps";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type Locator,
  type Page,
} from "playwright-core";

/** Settings of the web runner (REQ-EXEC-05, REQ-EVD-02, REQ-EVD-06). */
export interface WebRunnerOptions {
  /** Chromium by default; Firefox and WebKit configurable (REQ-EXEC-05/AC1). */
  readonly browser?: "chromium" | "firefox" | "webkit";
  /** `retain-on-failure` by default, `always` or `off` (REQ-EVD-06/AC1). */
  readonly video?: "retain-on-failure" | "always" | "off";
  /** Where the app keeps its session token; the framework sets it for `ui.as(alias)` (REQ-CFG-07). */
  readonly webSession?:
    { readonly storage: "sessionStorage" | "localStorage"; readonly key: string } | undefined;
  readonly headless?: boolean;
  /** Timeout of one UI action (click, fill, wait). */
  readonly actionTimeoutMs?: number;
  readonly viewport?: { readonly width: number; readonly height: number };
}

/**
 * Turns a spec selector into a Playwright locator: test ids and accessible roles first, CSS last
 * (REQ-EXEC-05/AC2).
 *
 * @param page - Page.
 * @param selector - `testid:<id>`, `role:<role>[:<name>]`, `label:<text>`, `text:<text>` or `css:<selector>`.
 */
export function locate(page: Page, selector: string): Locator {
  const i = selector.indexOf(":");
  const kind = selector.slice(0, i);
  const rest = selector.slice(i + 1);
  switch (kind) {
    case "testid":
      return page.getByTestId(rest);
    case "role": {
      const j = rest.indexOf(":");
      const role = (j < 0 ? rest : rest.slice(0, j)) as Parameters<Page["getByRole"]>[0];
      return j < 0 ? page.getByRole(role) : page.getByRole(role, { name: rest.slice(j + 1), exact: true });
    }
    case "label":
      return page.getByLabel(rest, { exact: true });
    case "text":
      return page.getByText(rest, { exact: true });
    case "css":
      return page.locator(rest);
    default:
      throw new Error(`Invalid selector '${selector}'`);
  }
}

/** Masks credentials in a HAR file: sensitive headers, cookies and registered secret values. */
export function maskHar(text: string, maskText: (t: string) => string): string {
  const sensitive = new Set(DEFAULT_SENSITIVE_HEADERS);
  let har: unknown;
  try {
    har = JSON.parse(text);
  } catch {
    return maskText(text);
  }
  const scrub = (pairs: unknown): unknown =>
    Array.isArray(pairs)
      ? pairs.map((p: { name?: unknown; value?: unknown }) =>
          sensitive.has(String(p.name).toLowerCase()) ? { ...p, value: MASK } : p,
        )
      : pairs;
  const entries =
    (har as { log?: { entries?: Record<string, Record<string, unknown>>[] } }).log?.entries ?? [];
  for (const e of entries) {
    for (const side of ["request", "response"]) {
      const part = e[side];
      if (!part) continue;
      part["headers"] = scrub(part["headers"]);
      if (Array.isArray(part["cookies"]))
        part["cookies"] = (part["cookies"] as Record<string, unknown>[]).map((c) => ({ ...c, value: MASK }));
    }
  }
  return maskText(JSON.stringify(har, null, 2));
}

/**
 * Creates the browser factory of the web runner. One browser context per attempt, with video, HAR,
 * trace and console capture; the parent performs every action (ADR-0004).
 *
 * @param options - Browser, media policy, session storage and timeouts.
 */
export function createPlaywrightBrowserFactory(options: WebRunnerOptions = {}): BrowserFactory {
  const video = options.video ?? "retain-on-failure";
  const timeout = options.actionTimeoutMs ?? 5_000;
  return (input: AttemptInput): BrowserSession => {
    const masker = createMasker({ secrets: input.secrets });
    let started:
      { browser: Browser; context: BrowserContext; page: Page; dir: string; console: string[] } | undefined;

    const start = async (): Promise<UiDriver> => {
      const dir = await mkdtemp(join(tmpdir(), "qj-web-"));
      const type = options.browser === "firefox" ? firefox : options.browser === "webkit" ? webkit : chromium;
      const browser = await type.launch({ headless: options.headless ?? true });
      const context = await browser.newContext({
        baseURL: input.baseUrl,
        viewport: options.viewport ?? { width: 1280, height: 800 },
        ...(video === "off"
          ? {}
          : { recordVideo: { dir: join(dir, "video"), size: { width: 1280, height: 800 } } }),
        recordHar: { path: join(dir, "network.har"), content: "omit" },
      });
      context.setDefaultTimeout(timeout);
      // Navigation and requests stay inside the environment allowlist (invariant 10).
      await context.route("**/*", (route) => {
        const origin = new URL(route.request().url()).origin;
        if (input.allowedOrigins.includes(origin) || origin === "null") void route.continue();
        else void route.abort("blockedbyclient");
      });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      const console: string[] = [];
      page.on("console", (m) => console.push(`[${m.type()}] ${m.text()}`));
      page.on("pageerror", (e) => console.push(`[pageerror] ${e.message}`));
      started = { browser, context, page, dir, console };
      const p = page;
      return {
        goto: async (url) => {
          await p.goto(url, { waitUntil: "load" });
        },
        click: (s) => locate(p, s).click(),
        fill: (s, v) => locate(p, s).fill(v),
        check: (s, checked) => locate(p, s).setChecked(checked),
        select: async (s, v) => {
          await locate(p, s).selectOption(v);
        },
        press: (s, k) => locate(p, s).press(k),
        waitFor: (s, state) => locate(p, s).waitFor({ state }),
        pageText: () => p.locator("body").innerText(),
        url: () => p.url(),
        property: async (s, property: UiProperty) => {
          const l = locate(p, s);
          switch (property) {
            case "visible":
              return l.isVisible();
            case "enabled":
              return l.first().isEnabled({ timeout });
            case "checked":
              return l.first().isChecked({ timeout });
            case "text":
              return (await l.first().innerText({ timeout })).trim();
            case "value":
              return l.first().inputValue({ timeout });
          }
        },
        useAccount: async (alias) => {
          const token = input.sessions?.[alias];
          if (token === undefined || !options.webSession)
            throw new Error(`No browser session for '${alias}': set web_session in the environment profile`);
          const { storage, key } = options.webSession;
          const origin = new URL(input.baseUrl).origin;
          await context.addInitScript(
            ([o, s, k, t]) => {
              // Runs in the page; typed structurally because the Node build has no DOM types.
              interface Store {
                setItem(key: string, value: string): void;
              }
              const w = globalThis as unknown as {
                location: { origin: string };
                localStorage: Store;
                sessionStorage: Store;
              };
              if (w.location.origin === o)
                (s === "localStorage" ? w.localStorage : w.sessionStorage).setItem(k, t);
            },
            [origin, storage, key, token] as const,
          );
        },
        screenshot: async (fullPage) => new Uint8Array(await p.screenshot({ fullPage })),
        dom: () => p.content(),
      };
    };

    return {
      driver: start,
      close: async (failed) => {
        if (!started) return [];
        const { browser, context, page, dir, console } = started;
        const items: EvidenceItem[] = [];
        const keepTrace = failed;
        if (keepTrace) await context.tracing.stop({ path: join(dir, "trace.zip") });
        else await context.tracing.stop();
        const videoPath = await page
          .video()
          ?.path()
          .catch(() => undefined);
        await context.close();
        await browser.close();
        try {
          if (keepTrace)
            items.push({
              stepId: "case",
              kind: "trace",
              name: "trace.zip",
              content: new Uint8Array(await readFile(join(dir, "trace.zip"))),
            });
          if (videoPath && (video === "always" || (video === "retain-on-failure" && failed))) {
            items.push({
              stepId: "case",
              kind: "video",
              name: "video.webm",
              content: new Uint8Array(await readFile(videoPath)),
            });
          }
          items.push({
            stepId: "case",
            kind: "har",
            name: "network.har",
            content: maskHar(await readFile(join(dir, "network.har"), "utf8"), (t) => masker.maskText(t)),
          });
          items.push({
            stepId: "case",
            kind: "log",
            name: "console.log",
            content: masker.maskText(`${console.join("\n")}\n`),
          });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        return items;
      },
    };
  };
}
