import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import type { AttemptInput, BrowserFactory, BrowserSession } from "@qajitsu/adapter-runner-api";
import {
  createMasker,
  DEFAULT_SENSITIVE_HEADERS,
  MASK,
  selectorParts,
  type EvidenceItem,
  type UiDriver,
  type UiProperty,
} from "@qajitsu/steps";
import { OBSERVATIONS_FILE, type PassiveObservations, type UiElementFact } from "@qajitsu/core";
import { ariaElements } from "./aria.js";
import {
  chromium,
  firefox,
  selectors,
  webkit,
  type Browser,
  type BrowserContext,
  type FrameLocator,
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
  /** Attribute `testid:` selectors find, e.g. `data-qa` (REQ-EXEC-21/AC1); `data-testid` by default. */
  readonly testIdAttribute?: string;
  readonly viewport?: { readonly width: number; readonly height: number };
  /** HTTP authentication of the environment (REQ-EXEC-61/AC5), sent when a page asks for it. */
  readonly httpCredentials?: { readonly username: string; readonly password: string } | undefined;
  /** Largest download a step reads, in bytes (REQ-EXEC-38/AC2); 100 MB by default. */
  readonly maxDownloadBytes?: number;
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

/** Visible elements with a test id, read in the page (CDP evaluation): id, tag, text and state. */
const testIdScript = (
  attribute: string,
): string => `[...document.querySelectorAll(${JSON.stringify(`[${attribute}]`)})]
  .filter((e) => e.getClientRects().length > 0)
  .slice(0, 400)
  .map((e) => ({
    testid: e.getAttribute(${JSON.stringify(attribute)}),
    role: e.tagName.toLowerCase(),
    text: (e.innerText || "").trim().replace(/\\s+/g, " ").slice(0, 120),
    disabled: e.disabled === true || e.getAttribute("aria-disabled") === "true",
    checked: e.checked === true,
  }))`;

/**
 * The elements of a page for a snapshot (REQ-EXEC-22/AC1): every accessible element from Playwright's accessibility
 * snapshot, then every visible element with a test id.
 */
async function pageElements(page: Page, testIdAttribute: string): Promise<UiElementFact[]> {
  const accessible = ariaElements(await page.locator("body").ariaSnapshot({ timeout: 5000 }));
  const withId = await page.evaluate<
    { testid: string; role: string; text: string; disabled: boolean; checked: boolean }[]
  >(testIdScript(testIdAttribute));
  return [
    ...withId.map((e) => ({
      testid: e.testid,
      role: e.role,
      ...(e.text !== "" ? { text: e.text } : {}),
      ...(e.disabled ? { disabled: true } : {}),
      ...(e.checked ? { checked: true } : {}),
    })),
    ...accessible,
  ];
}

/**
 * Turns a spec selector into a Playwright locator: test ids and accessible roles first, CSS last
 * (REQ-EXEC-05/AC2).
 *
 * @param page - Page.
 * @param selector - `testid:<id>`, `role:<role>[:<name>]`, `label:`, `placeholder:`, `alt:`, `title:`, `text:`,
 *   `id:<dom id>` or `css:<selector>` (REQ-EXEC-21/AC3).
 */
export function locate(page: Page, selector: string): Locator {
  // REQ-EXEC-39 + REQ-EXEC-64: frames, elements inside elements, and the filters has-text: and nth:.
  let root: Page | FrameLocator | Locator = page;
  let current: Locator | undefined;
  for (const part of selectorParts(selector)) {
    if (part.kind === "frame") {
      root = locateIn(current ?? root, part.selector)
        .first()
        .contentFrame();
      current = undefined;
    } else if (part.kind === "element") current = locateIn(current ?? root, part.selector);
    else if (current && part.kind === "hasText") current = current.filter({ hasText: part.text });
    else if (current && part.kind === "nth") current = current.nth(part.n - 1);
  }
  if (!current) throw new Error(`Selector '${selector.slice(0, 60)}' names no element`);
  return current;
}

/** A locator of one selector (no chain) in a page, a frame or inside another element. */
function locateIn(page: Page | FrameLocator | Locator, selector: string): Locator {
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
    case "placeholder":
      return page.getByPlaceholder(rest, { exact: true });
    case "alt":
      return page.getByAltText(rest, { exact: true });
    case "title":
      return page.getByTitle(rest, { exact: true });
    case "text":
      return page.getByText(rest, { exact: true });
    case "id":
      return page.locator(`[id=${JSON.stringify(rest)}]`);
    case "css":
      return page.locator(rest);
    default:
      throw new Error(
        `Selector '${selector.slice(0, 60)}' is not supported in a browser: use testid:, role:, label:, placeholder:, alt:, title:, text:, id: or css:`,
      );
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

/** Largest download a step reads (REQ-EXEC-38/AC2): 100 MB. */
const MAX_DOWNLOAD = 100_000_000;

/** A rectangle as `getBoundingClientRect` returns it (the Node build has no DOM types). */
interface DOMRectLike {
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly width: number;
  readonly height: number;
}

/** A node of the CDP DOM tree. */
interface CdpNode {
  readonly localName?: string;
  readonly attributes?: readonly string[];
  readonly shadowRootType?: string;
  readonly children?: readonly CdpNode[];
  readonly shadowRoots?: readonly CdpNode[];
  readonly contentDocument?: CdpNode;
}

/** Hosts of closed shadow roots in a CDP DOM tree, as `tag#id` or `tag`. */
export function closedShadowHosts(node: CdpNode, out: string[] = [], depth = 0): string[] {
  if (depth > 200) return out;
  for (const root of node.shadowRoots ?? []) {
    if (root.shadowRootType === "closed") {
      const attrs = node.attributes ?? [];
      const id = attrs[attrs.indexOf("id") + 1];
      out.push(`${node.localName ?? "element"}${attrs.includes("id") && id ? `#${id}` : ""}`);
    }
    closedShadowHosts(root, out, depth + 1);
  }
  for (const child of node.children ?? []) closedShadowHosts(child, out, depth + 1);
  if (node.contentDocument) closedShadowHosts(node.contentDocument, out, depth + 1);
  return out;
}

const scrollY = (page: Page): Promise<number> =>
  page.evaluate(() => (globalThis as unknown as { scrollY: number }).scrollY).catch(() => 0);

/**
 * Creates the browser factory of the web runner. One browser context per attempt, with video, HAR,
 * trace and console capture; the parent performs every action (ADR-0004).
 *
 * @param options - Browser, media policy, session storage and timeouts.
 */
export function createPlaywrightBrowserFactory(options: WebRunnerOptions = {}): BrowserFactory {
  const video = options.video ?? "retain-on-failure";
  const timeout = options.actionTimeoutMs ?? 5_000;
  const testIdAttribute = options.testIdAttribute ?? "data-testid";
  return (input: AttemptInput): BrowserSession => {
    const masker = createMasker({ secrets: input.secrets });
    const observed: PassiveObservations = { console: [], http: [], accessibility: [] };
    const audits: Promise<void>[] = [];
    let started:
      { browser: Browser; context: BrowserContext; page: Page; dir: string; console: string[] } | undefined;

    const start = async (): Promise<UiDriver> => {
      const dir = await mkdtemp(join(tmpdir(), "qj-web-"));
      const type = options.browser === "firefox" ? firefox : options.browser === "webkit" ? webkit : chromium;
      // REQ-EXEC-21/AC1: getByTestId finds the project's attribute (one project per process).
      selectors.setTestIdAttribute(testIdAttribute);
      const browser = await type.launch({
        headless: options.headless ?? true,
        ...(options.slowMoMs ? { slowMo: options.slowMoMs } : {}),
      });
      // REQ-EXEC-61/AC3: the case's browser grants only what its plan names; everything else stays denied.
      const settings = input.plan.cases.find((c) => c.id === input.caseId)?.browser;
      const context = await browser.newContext({
        baseURL: input.baseUrl,
        viewport: options.viewport ?? { width: 1280, height: 800 },
        ...(options.httpCredentials
          ? {
              httpCredentials: {
                ...options.httpCredentials,
                origin: new URL(input.baseUrl).origin,
                send: "unauthorized" as const,
              },
            }
          : {}),
        ...(settings?.permissions ? { permissions: [...settings.permissions] } : {}),
        ...(settings?.geolocation
          ? {
              geolocation: {
                latitude: settings.geolocation.latitude,
                longitude: settings.geolocation.longitude,
                ...(settings.geolocation.accuracy === undefined
                  ? {}
                  : { accuracy: settings.geolocation.accuracy }),
              },
            }
          : {}),
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
      // Navigations a page was refused, so a pop-up to another host is named (REQ-EXEC-39/AC3).
      const blockedNavigation = new Map<Page, string>();
      let lastBlocked: { origin: string; at: number } | undefined;
      await context.route("**/*", (route) => {
        const request = route.request();
        if (allowed(request.url())) {
          void route.continue();
          return;
        }
        if (request.isNavigationRequest()) {
          const origin = new URL(request.url()).origin;
          lastBlocked = { origin, at: Date.now() };
          try {
            blockedNavigation.set(request.frame().page(), origin);
          } catch {
            // A pop-up's first navigation or a worker's request may have no page yet.
          }
        }
        void route.abort("blockedbyclient");
      });
      // WebSockets bypass page.route; check them against the same allowlist.
      await context.routeWebSocket(/.*/, (ws) => {
        const wsUrl = new URL(ws.url());
        const httpOrigin = `${wsUrl.protocol === "wss:" ? "https:" : "http:"}//${wsUrl.host}`;
        if (input.allowedOrigins.includes(httpOrigin)) ws.connectToServer();
        else void ws.close({ code: 1008, reason: "blocked by QAJitsu allowlist" });
      });
      await context.tracing.start({ screenshots: true, snapshots: true });
      // REQ-EXEC-61/AC2: the case starts at the plan's time; time flows from there and steps can move it forward.
      let clockInstalled = false;
      if (settings?.clock !== undefined) {
        await context.clock.install({ time: new Date(settings.clock) });
        await context.clock.resume();
        clockInstalled = true;
      }
      const page = await context.newPage();
      const console: string[] = [];
      // Every page of the case, in the order it opened (REQ-EXEC-39): pop-ups and tabs get the same recording.
      const pages: Page[] = [page];
      /** Pages a switch already went to or refused: each pop-up is taken once. */
      const taken = new Set<Page>([page]);
      // REQ-EXEC-61/AC1: dialogs are answered as the step says, otherwise dismissed, and always recorded.
      let dialogPolicy:
        { readonly action: "accept" | "dismiss"; readonly text?: string | undefined } | undefined;
      const dialogs: { type: string; message: string; answer: string }[] = [];
      const wire = (pg: Page): void => {
        pg.on("console", (m) => console.push(`[${m.type()}] ${m.text()}`));
        pg.on("pageerror", (e) => console.push(`[pageerror] ${e.message}`));
        pg.on("dialog", (dialog) => {
          const accept = dialogPolicy?.action === "accept";
          dialogs.push({
            type: dialog.type(),
            message: dialog.message(),
            answer: accept
              ? dialogPolicy?.text !== undefined
                ? `accepted with text`
                : "accepted"
              : "dismissed",
          });
          void (accept ? dialog.accept(dialogPolicy?.text) : dialog.dismiss()).catch(() => undefined);
        });
      };
      wire(page);
      context.on("page", (pg) => {
        if (!pages.includes(pg)) {
          pages.push(pg);
          wire(pg);
        }
      });
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
      let p = page;
      const pageRef = (pg: Page) => ({ index: pages.indexOf(pg), url: pg.url() });
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
            case "in_viewport":
              // Inside the visible part of the window, after scrolling (REQ-EXEC-40/AC2).
              return (await l.count()) > 0
                ? l.first().evaluate((el) => {
                    const r = (
                      el as unknown as { getBoundingClientRect(): DOMRectLike }
                    ).getBoundingClientRect();
                    const w = globalThis as unknown as { innerWidth: number; innerHeight: number };
                    return (
                      r.width > 0 &&
                      r.height > 0 &&
                      r.bottom > 0 &&
                      r.right > 0 &&
                      r.top < w.innerHeight &&
                      r.left < w.innerWidth
                    );
                  })
                : false;
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
        // REQ-EVD-08: the element's box on the viewport screenshot (device scale factor 1).
        bounds: async (s) =>
          (await locate(p, s)
            .first()
            .boundingBox({ timeout: 1000 })
            .catch(() => null)) ?? undefined,
        elements: () => pageElements(p, testIdAttribute),
        // REQ-EXEC-40: pointer, keyboard and scroll actions.
        pointer: async (s, kind) => {
          const l = locate(p, s);
          if (kind === "hover") await l.hover();
          else if (kind === "dblclick") await l.dblclick();
          else await l.click({ button: "right" });
        },
        dragTo: (source, target) => locate(p, source).dragTo(locate(p, target)),
        dragBy: async (s, dx, dy) => {
          const box = await locate(p, s).first().boundingBox({ timeout });
          if (!box) throw new Error(`${s} has no position on the page to drag from`);
          const x = box.x + box.width / 2;
          const y = box.y + box.height / 2;
          await p.mouse.move(x, y);
          await p.mouse.down();
          await p.mouse.move(x + dx, y + dy, { steps: 10 });
          await p.mouse.up();
        },
        keys: (combination) => p.keyboard.press(combination),
        scrollTo: (s) => locate(p, s).first().scrollIntoViewIfNeeded({ timeout }),
        scrollBy: async (dx, dy) => {
          await p.mouse.wheel(dx, dy);
          await p.waitForTimeout(150);
        },
        scrollUntil: async (s, limit) => {
          const l = locate(p, s).first();
          const height = p.viewportSize()?.height ?? 800;
          let scrolls = 0;
          for (;;) {
            if (await l.isVisible().catch(() => false)) {
              await l.scrollIntoViewIfNeeded({ timeout }).catch(() => undefined);
              return { scrolls, found: true, y: await scrollY(p) };
            }
            if (scrolls >= limit) return { scrolls, found: false, y: await scrollY(p) };
            await p.mouse.wheel(0, Math.round(height * 0.8));
            scrolls += 1;
            // Lists load more rows when they come into view.
            await p.waitForLoadState("networkidle", { timeout: 2000 }).catch(() => undefined);
            await p.waitForTimeout(150);
          }
        },
        // REQ-EXEC-38: a file input gets the files; a button opening a file chooser gets them through it; a drop zone
        // gets them dropped.
        upload: async (s, files) => {
          const l = locate(p, s).first();
          const payload = files.map((f) => ({ name: f.name, mimeType: f.type, buffer: Buffer.from(f.data) }));
          const isInput = await l.evaluate((el) => {
            const e = el as unknown as { tagName: string; type?: string };
            return e.tagName === "INPUT" && e.type === "file";
          });
          if (isInput) {
            await l.setInputFiles(payload);
            return;
          }
          const chooser = p.waitForEvent("filechooser", { timeout: 1500 }).catch(() => undefined);
          await l.click();
          const opened = await chooser;
          if (opened) {
            await opened.setFiles(payload);
            return;
          }
          await l.evaluate(
            (el, list) => {
              type FileCtor = new (bits: Uint8Array[], name: string, options: { type: string }) => unknown;
              const w = globalThis as unknown as {
                DataTransfer: new () => { items: { add(file: unknown): void } };
                File: FileCtor;
                DragEvent: new (type: string, init: Record<string, unknown>) => unknown;
                atob(data: string): string;
              };
              const dt = new w.DataTransfer();
              for (const f of list)
                dt.items.add(
                  new w.File([Uint8Array.from(w.atob(f.b64), (c) => c.charCodeAt(0))], f.name, {
                    type: f.type,
                  }),
                );
              const target = el as unknown as { dispatchEvent(event: unknown): boolean };
              for (const type of ["dragenter", "dragover", "drop"])
                target.dispatchEvent(
                  new w.DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }),
                );
            },
            files.map((f) => ({ name: f.name, type: f.type, b64: Buffer.from(f.data).toString("base64") })),
          );
        },
        download: async (s, waitMs) => {
          const [d] = await Promise.all([
            p.waitForEvent("download", { timeout: waitMs }),
            locate(p, s).first().click(),
          ]);
          const failure = await d.failure();
          if (failure !== null) throw new Error(`the download from ${s} failed: ${failure}`);
          const path = await d.path();
          // A download larger than any test needs is refused before it is read into memory.
          const size = (await stat(path)).size;
          const limit = options.maxDownloadBytes ?? MAX_DOWNLOAD;
          if (size > limit)
            throw new Error(
              `the download from ${s} has ${String(size)} bytes, more than ${String(limit)} a test reads`,
            );
          return { name: d.suggestedFilename(), data: new Uint8Array(await readFile(path)) };
        },
        // REQ-EXEC-39/AC2+AC3: pop-ups and tabs.
        switchPage: async (to, waitMs) => {
          if (to === "opener") {
            const opener = await p.opener();
            if (!opener) throw new Error("this page was not opened by another page");
            p = opener;
            await p.bringToFront();
            return pageRef(p);
          }
          // The newest page not taken or refused yet; otherwise the next one that opens.
          const next =
            pages.filter((pg) => !taken.has(pg) && pg !== p).at(-1) ??
            (await context.waitForEvent("page", { timeout: waitMs }).catch(() => undefined));
          if (next) taken.add(next);
          if (!next) throw new Error(`no pop-up or tab opened within ${String(waitMs / 1000)} s`);
          await next.waitForLoadState("load", { timeout: waitMs }).catch(() => undefined);
          // The pop-up's page, its URL outside the allowlist, or a navigation refused while it opened.
          const url = next.url();
          const outside = /^https?:/.test(url) && !allowed(url) ? new URL(url).origin : undefined;
          const recent =
            lastBlocked !== undefined && Date.now() - lastBlocked.at < waitMs && !/^https?:/.test(url)
              ? lastBlocked.origin
              : undefined;
          const blocked = blockedNavigation.get(next) ?? outside ?? recent;
          if (blocked !== undefined)
            throw new Error(`the pop-up opened ${blocked}, which is not on the environment allowlist`);
          p = next;
          await p.bringToFront();
          return pageRef(p);
        },
        closePage: async () => {
          if (p === page) throw new Error("the first page of the case cannot be closed");
          const opener = (await p.opener()) ?? page;
          await p.close();
          p = opener;
          return pageRef(p);
        },
        currentPage: () => pageRef(p),
        setDialogPolicy: (policy) => {
          dialogPolicy = policy;
        },
        takeDialogs: () => dialogs.splice(0),
        advanceTime: async (ms) => {
          if (!clockInstalled) {
            await context.clock.install();
            await context.clock.resume();
            clockInstalled = true;
          }
          await context.clock.fastForward(ms);
        },
        // REQ-EXEC-56/AC2: the application's own test state; read here, never passed by the spec.
        testState: (hook, path) =>
          p.evaluate(
            ([h, path]) => {
              const w = globalThis as unknown as Record<string, unknown>;
              let v: unknown = w[h];
              if (v === undefined) return { hook: false, value: undefined };
              if (typeof v === "function") v = (v as () => unknown)();
              for (const part of path.match(/[^.[\]]+/g) ?? []) {
                if (v === null || typeof v !== "object") return { hook: true, value: undefined };
                v = (v as Record<string, unknown>)[part];
              }
              return { hook: true, value: JSON.parse(JSON.stringify(v ?? null)) as unknown };
            },
            [hook, path] as const,
          ),
        elementScreenshot: async (s) => new Uint8Array(await locate(p, s).first().screenshot({ timeout })),
        // REQ-EXEC-56/AC1: a closed shadow root is out of reach of every selector; Chromium can tell.
        unreachableReason: async () => {
          if (options.browser !== undefined && options.browser !== "chromium") return undefined;
          const cdp = await context.newCDPSession(p);
          try {
            const { root } = (await cdp.send("DOM.getDocument", { depth: -1, pierce: true })) as {
              root: CdpNode;
            };
            const hosts = closedShadowHosts(root);
            return hosts.length > 0
              ? `the page has closed shadow roots (in ${hosts.slice(0, 3).join(", ")}), which no selector can reach: ask for an open shadow root or a test id on the host`
              : undefined;
          } finally {
            await cdp.detach().catch(() => undefined);
          }
        },
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
