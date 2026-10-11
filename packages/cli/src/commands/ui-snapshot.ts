import type { BrowserFactory } from "@qajitsu/adapter-runner-api";
import { accountsUsedBy, type Plan, type UiScreen } from "@qajitsu/core";

/** Pages recorded per case and per run, so a snapshot stays quick and its prompt section small (REQ-EXEC-22/AC2). */
const PAGES_PER_CASE = 5;
const PAGES_PER_RUN = 12;
/** Elements kept per page or screen. */
const ELEMENTS_PER_SCREEN = 300;

type PlanCase = Plan["cases"][number];

/**
 * The pages to record for a web case (REQ-EXEC-22/AC1): the paths its text names, in order, keeping only UI pages
 * when the code's page list is known (an API path such as `/cart` is not a page then); the start page when it names
 * none.
 *
 * @param planCase - A web case of the approved plan.
 * @param knownPages - Pages of the code inventory; empty when the code is not available.
 */
export function snapshotPages(planCase: PlanCase, knownPages: readonly string[]): string[] {
  const text = JSON.stringify({
    title: planCase.title,
    preconditions: planCase.preconditions,
    steps: planCase.steps.map((s) => [s.action, s.instructions, s.expect.description]),
  });
  const found = [...text.matchAll(/(?<![\w:/.-])\/[A-Za-z0-9_\-./]*[A-Za-z0-9_-]/g)].map((m) =>
    m[0].replace(/\/+$/, ""),
  );
  const pages = [...new Set(found)].filter((p) => knownPages.length === 0 || knownPages.includes(p));
  return pages.length > 0 ? pages.slice(0, PAGES_PER_CASE) : ["/"];
}

/** What the snapshot needs from the run: browser and device sessions, logins and masking. */
export interface UiSnapshotInput {
  readonly plan: Plan;
  /** UI cases that get a spec written now. */
  readonly cases: readonly PlanCase[];
  readonly web?: {
    readonly factory: BrowserFactory;
    /** Logs the aliases in (holding pool accounts until `release`), like an attempt does (REQ-ENV-09). */
    readonly login: (aliases: readonly string[]) => Promise<{
      readonly accounts: Readonly<Record<string, Readonly<Record<string, string>>>>;
      readonly secrets: readonly string[];
      readonly sessions?: Readonly<Record<string, string>>;
      readonly release?: () => void;
    }>;
    /** Account aliases of the environment. */
    readonly aliases: readonly string[];
    readonly knownPages: readonly string[];
    readonly baseUrl: string;
    readonly allowedOrigins: readonly string[];
  };
  readonly mobile?: { readonly factory: BrowserFactory; readonly platform: "android" | "ios" };
  /** The run's masker (REQ-EXEC-22/AC2); registered secrets of the logins are masked too. */
  readonly mask: (value: unknown) => unknown;
  /** Journal events: `ui.snapshot` per recorded screen, `ui.snapshot.failed` with the reason. */
  readonly emit: (event: string, details: Record<string, unknown>) => void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/**
 * Records the pages and screens of the running application before the author writes specs (REQ-EXEC-22): the trusted
 * parent opens each web case's pages as the case's account and the first screen of the native app, and keeps the
 * elements they show, masked. Nothing is kept as evidence or results; a page that cannot be recorded is journaled and
 * left out, and the author works without it (AC6). Sessions go through the same factories, and so through the same
 * environment allowlist, as test attempts (AC5).
 *
 * @param input - Cases, factories, logins and masking of the run.
 * @returns The recorded screens, masked.
 */
export async function recordUiSnapshot(input: UiSnapshotInput): Promise<UiScreen[]> {
  const screens: UiScreen[] = [];
  const failed = (where: string, platform: string, error: unknown): void => {
    input.emit("ui.snapshot.failed", {
      where,
      platform,
      error: (input.mask({ error: message(error) }) as { error: string }).error.slice(0, 500),
    });
  };
  const keep = (screen: UiScreen): void => {
    const masked = input.mask(screen) as UiScreen;
    const elements = masked.elements.slice(0, ELEMENTS_PER_SCREEN);
    screens.push({ ...masked, elements });
    input.emit("ui.snapshot", { where: screen.where, platform: screen.platform, elements: elements.length });
  };
  const request = (caseId: string) => ({
    specFile: "",
    caseId,
    attempt: 0,
    plan: input.plan,
    timeoutMs: 60_000,
  });

  const web = input.web;
  if (web) {
    // One browser session per account; each page once, in the order the cases name them.
    const groups = new Map<string, { caseId: string; pages: string[] }>();
    let total = 0;
    for (const c of input.cases.filter((x) => x.type === "web")) {
      const [account = ""] = accountsUsedBy(JSON.stringify(c), web.aliases);
      const group = groups.get(account) ?? { caseId: c.id, pages: [] };
      for (const page of snapshotPages(c, web.knownPages))
        if (!group.pages.includes(page) && total < PAGES_PER_RUN) {
          group.pages.push(page);
          total += 1;
        }
      groups.set(account, group);
    }
    for (const [account, group] of groups) {
      if (group.pages.length === 0) continue;
      let login: Awaited<ReturnType<typeof web.login>> | undefined;
      try {
        login = account === "" ? undefined : await web.login([account]);
      } catch (error) {
        failed(group.pages[0] ?? "/", "web", error);
        continue;
      }
      const session = web.factory({
        ...request(group.caseId),
        baseUrl: web.baseUrl,
        allowedOrigins: web.allowedOrigins,
        accounts: login?.accounts ?? {},
        secrets: login?.secrets ?? [],
        ...(login?.sessions ? { sessions: login.sessions } : {}),
      });
      try {
        const driver = await session.driver();
        if (account !== "") await driver.useAccount(account);
        for (const where of group.pages) {
          try {
            await driver.goto(where);
            if (!driver.elements) continue;
            keep({
              where,
              platform: "web",
              ...(account !== "" ? { account } : {}),
              elements: await driver.elements(),
            });
          } catch (error) {
            failed(where, "web", error);
          }
        }
      } catch (error) {
        failed(group.pages[0] ?? "/", "web", error);
      } finally {
        // AC2: what the session collected (video, HAR, logs) is dropped, never evidence.
        await session.close(false).catch(() => []);
        login?.release?.();
      }
    }
  }

  const mobile = input.mobile;
  const first = input.cases.find((c) => c.type === "mobile");
  if (mobile && first) {
    const session = mobile.factory({
      ...request(first.id),
      baseUrl: "",
      allowedOrigins: [],
      accounts: {},
      secrets: [],
    });
    try {
      const driver = await session.driver();
      if (driver.elements)
        keep({ where: "app:start", platform: mobile.platform, elements: await driver.elements() });
    } catch (error) {
      failed("app:start", mobile.platform, error);
    } finally {
      await session.close(false).catch(() => []);
    }
  }
  return screens;
}
