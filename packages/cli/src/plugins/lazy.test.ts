import { describe, expect, it } from "vitest";
import type { AttemptInput, BrowserSession } from "@qajitsu/adapter-runner-api";
import { lazyBrowserFactory, lazyBrowserLogin, lazyPublisher } from "./lazy.js";

const input = { caseId: "TC-01" } as unknown as AttemptInput;

describe("plugins loaded on first use (REQ-GEN-11/AC2)", () => {
  it("REQ-GEN-11/AC2: a browser session that is never driven never loads the web runner", async () => {
    let loads = 0;
    const factory = lazyBrowserFactory(() => {
      loads += 1;
      return Promise.resolve(() => ({}) as BrowserSession);
    });
    const session = factory(input);
    expect(session.browser?.()).toBeUndefined();
    expect(await session.close(false)).toEqual([]);
    expect(loads).toBe(0);
  });

  it("REQ-GEN-11/AC2: the first drive loads the runner once and the session closes through it", async () => {
    let loads = 0;
    const closed: boolean[] = [];
    const factory = lazyBrowserFactory(() => {
      loads += 1;
      return Promise.resolve((): BrowserSession => ({
        driver: () => Promise.resolve({} as never),
        browser: () => ({ name: "chromium", version: "141" }),
        close: (failed) => {
          closed.push(failed);
          return Promise.resolve([]);
        },
      }));
    });
    const a = factory(input);
    const b = factory(input);
    await a.driver();
    await b.driver();
    expect(a.browser?.()).toEqual({ name: "chromium", version: "141" });
    await a.close(true);
    expect(loads).toBe(1);
    expect(closed).toEqual([true]);
  });

  it("REQ-GEN-11/AC2: a missing plugin fails the first login or publish with its error, every time", async () => {
    const missing = () => Promise.reject(new Error("qj plugin add runner-web"));
    const login = lazyBrowserLogin(missing);
    await expect(
      login({} as never, { username: "u", password: "p" }, { baseUrl: "x", allowedOrigins: [] }),
    ).rejects.toThrow("qj plugin add runner-web");
    const publisher = lazyPublisher("jira-cloud", () =>
      Promise.reject(new Error("qj plugin add publish-jira")),
    );
    expect(publisher.id).toBe("jira-cloud");
    await expect(publisher.publish({} as never)).rejects.toThrow("qj plugin add publish-jira");
    await expect(publisher.publish({} as never)).rejects.toThrow("qj plugin add publish-jira");
  });
});
