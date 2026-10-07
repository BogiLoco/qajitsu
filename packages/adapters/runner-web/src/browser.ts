import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
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
import { OBSERVATIONS_FILE, type PassiveObservations } from "@qajitsu/core";
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
  /** Delay before every browser action in ms, to watch a headed run (REQ-EXEC-16/AC2). */
  readonly slowMoMs?: number | undefined;
  /** Timeout of one UI action (click, fill, wait). */
  readonly actionTimeoutMs?: number;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** Passive observations (REQ-EVD-07); all on by default. They never change a status. */
  readonly observations?: {
    readonly console?: boolean;
    readonly httpErrors?: boolean;
    readonly accessibility?: boolean;
  };
}

let axeSource: Promise<string> | undefined;
/** axe-core's browser bundle, read once from the installed package. */
const loadAxe = (): Promise<string> => {
  axeSource ??= readFile(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
  return axeSource;
};

/** Runs axe-core in the page (CDP evaluation, not affected by the page's CSP) and returns WCAG A/AA violations. */
async function axeViolations(
  page: Page,
): Promise<{ rule: string; impact?: string; help: string; targets: string[] }[]> {
  await page.evaluate(await loadAxe());
  const found = await page.evaluate<{ rule: string; impact?: string; help: string; targets: string[] }[]>(
    `axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] }, resultTypes: ["violations"] })
      .then((r) => r.violations.map((v) => ({ rule: v.id, impact: v.impact || undefined, help: v.help,
        targets: v.nodes.slice(0, 5).map((n) => [].concat(n.target).join(" ")) })))`,
  );
  return found;
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
    const observed: PassiveObservations = { console: [], http: [], accessibility: [] };
    const audits: Promise<void>[] = [];
    let started:
      { browser: Browser; context: BrowserContext; page: Page; dir: string; console: string[] } | undefined;

    const start = async (): Promise<UiDriver> => {
      const dir = await mkdtemp(join(tmpdir(), "qj-web-"));
      const type = options.browser === "firefox" ? firefox : options.browser === "webkit" ? webkit : chromium;
      const browser = await type.launch({
        headless: options.headless ?? true,
        ...(options.slowMoMs ? { slowMo: options.slowMoMs } : {}),
      });
      const context = await browser.newContext({
        baseURL: input.baseUrl,
        viewport: options.viewport ?? { width: 1280, height: 800 },
        // REQ-EXEC-14: a locale run renders numbers, dates and currencies of its locale and time zone.
        ...(input.locale ? { locale: input.locale.name, timezoneId: input.locale.timezone } : {}),
        ...(video === "off"
          ? {}
          : { recordVideo: { dir: join(dir, "video"), size: { width: 1280, height: 800 } } }),
        recordHar: { path: join(dir, "network.har"), content: "omit" },
        // Service workers could fetch outside the route handler (invariant 10).
        serviceWorkers: "block",
      });
      context.setDefaultTimeout(timeout);
      // Navigation and requests stay inside the environment allowlist (invariant 10).
      const allowed = (url: string): boolean => {
        const u = new URL(url);
        if (["data:", "blob:", "about:"].includes(u.protocol)) return true;
        return input.allowedOrigins.includes(u.origin);
      };
      await context.route("**/*", (route) => {
        if (allowed(route.request().url())) void route.continue();
        else void route.abort("blockedbyclient");
      });
      // WebSockets bypass page.route; check them against the same allowlist.
      await context.routeWebSocket(/.*/, (ws) => {
        const wsUrl = new URL(ws.url());
        const httpOrigin = `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`;
        if (input.allowedOrigins.includes(httpOrigin)) ws.connectToServer();
        else void ws.close({ code: 1008, reason: "blocked by QAJitsu allowlist" });
      });
      await context.tracing.start({ screenshots: true, snapshots: true });
      const page = await context.newPage();
      const console: string[] = [];
      page.on("console", (m) => console.push(`[${m.type()}] ${m.text()}`));
      page.on("pageerror", (e) => console.push(`[pageerror] ${e.message}`));
      // REQ-EVD-07: passive observations, recorded by the parent and masked; they never become assertions.
      const want = options.observations ?? {};
      const pathOf = (url: string): string => {
        try {
          const u = new URL(url);
          return u.origin === new URL(input.baseUrl).origin
            ? `${u.pathname}${u.search}`
            : `${u.origin}${u.pathname}`;
        } catch {
          return url;
        }
      };
      if (want.console !== false) {
        page.on("console", (m) => {
          if (m.type() === "error")
            observed.console.push({ level: "error", text: m.text().slice(0, 2000), url: pathOf(page.url()) });
        });
        page.on("pageerror", (e) =>
          observed.console.push({
            level: "pageerror",
            text: e.message.slice(0, 2000),
            url: pathOf(page.url()),
          }),
        );
      }
      if (want.httpErrors !== false)
        page.on("response", (r) => {
          if (r.status() >= 400)
            observed.http.push({ method: r.request().method(), url: pathOf(r.url()), status: r.status() });
        });
      if (want.accessibility !== false) {
        const audited = new Set<string>();
        page.on("load", () => {
          const where = pathOf(page.url());
          if (audited.has(where) || where.startsWith("about:")) return;
          audited.add(where);
          audits.push(
            axeViolations(page).then(
              (found) => {
                for (const v of found) observed.accessibility.push({ ...v, url: where });
              },
              () => undefined,
            ),
          );
        });
      }
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
        back: async () => {
          await p.goBack();
        },
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
        screenshot: async (fullPage, masks) =>
          new Uint8Array(
            await p.screenshot({
              fullPage,
              ...(masks && masks.length > 0 ? { mask: masks.map((m) => locate(p, m)) } : {}),
            }),
          ),
        dom: () => p.content(),
      };
    };

    return {
      driver: start,
      close: async (failed) => {
        if (!started) return [];
        const { browser, context, page, dir, console } = started;
        const items: EvidenceItem[] = [];
        // Audits of the last pages finish before the browser closes.
        await Promise.all(audits);
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
          if (observed.console.length + observed.http.length + observed.accessibility.length > 0)
            items.push({
              stepId: "case",
              kind: "log",
              name: OBSERVATIONS_FILE,
              content: masker.maskText(`${JSON.stringify(observed, null, 2)}\n`),
            });
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
        return items;
      },
    };
  };
}

/**
 * Why a browser cannot run here, or undefined when its Playwright build is installed (REQ-EXEC-13/AC3).
 *
 * @param name - Browser of the matrix.
 * @param exists - File check, injectable for tests.
 */
export function browserUnavailable(
  name: "chromium" | "firefox" | "webkit",
  exists: (path: string) => boolean = existsSync,
): string | undefined {
  const type = name === "firefox" ? firefox : name === "webkit" ? webkit : chromium;
  let path: string;
  try {
    path = type.executablePath();
  } catch {
    path = "";
  }
  return path !== "" && exists(path)
    ? undefined
    : `${name} is not installed; install it with 'pnpm --filter @qajitsu/cli exec playwright-core install ${name}'`;
}
