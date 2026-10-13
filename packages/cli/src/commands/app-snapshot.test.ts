import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createAppiumDeviceFactory, type AppiumClient } from "@qajitsu/adapter-runner-mobile";
import { createPlaywrightBrowserFactory } from "@qajitsu/adapter-runner-web";
import type { BrowserFactory } from "@qajitsu/adapter-runner-api";
import { readRunIndex, type TicketKey, type UiScreen } from "@qajitsu/core";
import type { UiDriver } from "@qajitsu/steps";
import { afterEach, describe, expect, it } from "vitest";
import { analysis as buildAnalysis, createBuildProject, draft } from "../../../../tests/support/cli-build.js";
import { createDemoPipeline } from "../../../../tests/support/cli-pipeline.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0)) await c();
});

const analysis = JSON.stringify({
  summary: "Checkout needs accepted terms.",
  change_type: ["web"],
  screens: [{ name: "Checkout", source: [{ kind: "ac", id: "AC1" }] }],
  confidence: "high",
});

describe("pages of the environment for the planner (REQ-EXEC-22/AC7+AC8)", () => {
  it("REQ-EXEC-22/AC7+AC8: qj plan --snapshot records the pages reachable from the start page, as the account, and checks the plan against them", async () => {
    const p = await createDemoPipeline({
      ticket: "DEMO-4",
      ports: {
        snapshotBrowser: createPlaywrightBrowserFactory({
          video: "off",
          webSession: { storage: "sessionStorage", key: "token" },
          actionTimeoutMs: 3000,
        }),
      },
    });
    cleanups.push(p.cleanup);
    await p.run(["fetch", "DEMO-4", "--ref", "shop=main"]);
    const draft = JSON.parse(
      await readFile(new URL("../../../../fixtures/plans/demo-4-draft.json", import.meta.url), "utf8"),
    ) as {
      cases: { steps: { expect: { elements?: Record<string, unknown> } }[] }[];
    };
    // One expectation names an element no page shows: it is flagged before the person sees the plan.
    const first = draft.cases[0]?.steps[0]?.expect;
    if (first) first.elements = { ...first.elements, "role:button:Buy now": { visible: true } };
    const planned = await p.run(["plan", "DEMO-4", "--snapshot"], {
      script: [{ text: analysis }, { text: JSON.stringify(draft) }, { text: JSON.stringify(draft) }],
    });
    expect(planned.err).toBe("");
    expect(planned.out).toMatch(/Recorded \d+ page\(s\) or screen\(s\) of local for the planner\./);
    const screens = JSON.parse(await readFile(join(p.runDir, "ui", "snapshot.json"), "utf8")) as UiScreen[];
    expect(screens[0]).toMatchObject({ where: "/", platform: "web", account: "user:standard" });
    const checkout = screens.find((s) => s.where === "/app/checkout");
    expect(checkout?.elements).toContainEqual(expect.objectContaining({ testid: "place-order" }));
    expect(JSON.stringify(screens)).not.toContain("fictional-demo-password");
    const journal = await readFile(join(p.runDir, "journal", "events.jsonl"), "utf8");
    expect(journal).toContain('"event":"ui.snapshot"');
    expect(journal).toContain('"event":"plan.quality"');
    expect(planned.out).toContain(
      "role:button:Buy now matches no element recorded on the environment's pages",
    );
  });

  it("REQ-EXEC-22/AC7 + REQ-EXEC-23/AC1: before planning, the first screen of an installed app is recorded too", async () => {
    let stopped = false;
    const client = {
      $: () => Promise.reject(new Error("unused")),
      back: () => Promise.resolve(),
      execute: () => Promise.resolve(),
      keys: () => Promise.resolve(),
      getPageSource: () =>
        Promise.resolve(
          '<hierarchy><android.widget.Button class="android.widget.Button" text="Add item" content-desc="add-item" displayed="true"/></hierarchy>',
        ),
      takeScreenshot: () => Promise.resolve(""),
      startRecordingScreen: () => Promise.resolve(),
      stopRecordingScreen: () => Promise.resolve(""),
      getLogs: () => Promise.resolve([]),
      deleteSession: () => Promise.resolve(),
    } as unknown as AppiumClient;
    const p = await createDemoPipeline({
      ticket: "DEMO-4",
      ports: {
        snapshotBrowser: createPlaywrightBrowserFactory({
          video: "off",
          webSession: { storage: "sessionStorage", key: "token" },
          actionTimeoutMs: 3000,
        }),
        mobileDevice: () =>
          Promise.resolve({
            ok: true as const,
            factories: [
              createAppiumDeviceFactory({
                platform: "android",
                connect: () => Promise.resolve(client),
                capabilities: {},
              }),
            ],
            stop: () => {
              stopped = true;
              return Promise.resolve();
            },
          }),
      },
    });
    cleanups.push(p.cleanup);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      `${await readFile(yaml, "utf8")}\nmobile: { android: { app: { source: installed }, app_id: dev.qajitsu.demoshop } }\n`,
    );
    await p.run(["fetch", "DEMO-4", "--ref", "shop=main"]);
    const draft = await readFile(
      new URL("../../../../fixtures/plans/demo-4-draft.json", import.meta.url),
      "utf8",
    );
    const planned = await p.run(["plan", "DEMO-4", "--snapshot"], {
      script: [{ text: analysis }, { text: draft }],
    });
    expect(planned.err).toBe("");
    const screens = JSON.parse(await readFile(join(p.runDir, "ui", "snapshot.json"), "utf8")) as UiScreen[];
    expect(screens.at(-1)).toEqual({
      where: "app:start",
      platform: "android",
      elements: [{ role: "Button", testid: "add-item", text: "Add item" }],
    });
    expect(stopped).toBe(true);
  });

  it("REQ-EXEC-22/AC9: qj plan --build starts the environment and the app from the worktree to record them, then stops them", async () => {
    let stopped = false;
    const client = {
      getPageSource: () =>
        Promise.resolve(
          '<hierarchy><android.widget.TextView class="android.widget.TextView" text="Cart: 0 items" content-desc="cart-count" displayed="true"/></hierarchy>',
        ),
      startRecordingScreen: () => Promise.resolve(),
      stopRecordingScreen: () => Promise.resolve(""),
      getLogs: () => Promise.resolve([]),
      deleteSession: () => Promise.resolve(),
    } as unknown as AppiumClient;
    const pages: string[] = [];
    const browser: BrowserFactory = (input) => {
      let at = "";
      return {
        driver: () =>
          Promise.resolve({
            goto: async (path: string) => {
              // The built environment answers: the page exists only while it runs.
              const res = await fetch(new URL(path, input.baseUrl));
              if (!res.ok) throw new Error(`HTTP ${String(res.status)}`);
              at = path;
              pages.push(path);
            },
            elements: () => Promise.resolve(at === "/" ? [{ role: "heading", name: "Products" }] : []),
          } as unknown as UiDriver),
        close: () => Promise.resolve([]),
      };
    };
    const p = await createBuildProject(undefined, {
      ports: {
        snapshotBrowser: browser,
        mobileDevice: () =>
          Promise.resolve({
            ok: true as const,
            factories: [
              createAppiumDeviceFactory({
                platform: "android",
                connect: () => Promise.resolve(client),
                capabilities: {},
              }),
            ],
            stop: () => {
              stopped = true;
              return Promise.resolve();
            },
          }),
      },
    });
    cleanups.push(p.cleanup);
    const yaml = join(p.project, ".qa", "qa.project.yaml");
    await writeFile(
      yaml,
      `${await readFile(yaml, "utf8")}\nmobile: { android: { app: { source: path, repo: shop, path: app.apk }, app_id: dev.qajitsu.demoshop } }\n`,
    );
    expect((await p.run(["fetch", "DEMO-1"])).exitCode).toBe(0);
    const planned = await p.run(["plan", "DEMO-1", "--build"], [{ text: buildAnalysis }, { text: draft }]);
    expect(planned.err).toBe("");
    expect(planned.out).toContain(
      "Building the environment to record its pages and screens for the planner…",
    );
    expect(planned.out).toContain("Recorded 2 page(s) or screen(s) of build (local) for the planner.");
    const runId = (await readRunIndex(join(p.home, "runs"), "DEMO-1" as TicketKey)).latest ?? "";
    const dir = join(p.home, "runs", "DEMO-1", runId);
    const screens = JSON.parse(await readFile(join(dir, "ui", "snapshot.json"), "utf8")) as UiScreen[];
    expect(screens.map((s) => s.where)).toEqual(["/", "app:start"]);
    expect(screens[1]?.elements).toEqual([{ role: "TextView", testid: "cart-count", text: "Cart: 0 items" }]);
    expect(stopped).toBe(true);
    // The environment is stopped and its .env files are gone once planning has what it needs.
    expect(pages).toEqual(["/"]);
    expect(
      (await readdir(join(dir, "env")).catch(() => [] as string[])).filter((f) => f.endsWith(".env")),
    ).toEqual([]);
    const journal = await readFile(join(dir, "journal", "events.jsonl"), "utf8");
    expect(journal).toMatch(/"event":"env\.build","details":\{"ok":true\}/);
  }, 240_000);
});
