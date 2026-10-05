import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: Record<string, unknown>[] = [];
vi.mock("webdriverio", () => ({
  remote: (options: Record<string, unknown>) => {
    calls.push(options);
    return Promise.resolve({});
  },
}));
const { connectAppium } = await import("./connect.js");

describe("Appium connection (REQ-EXEC-06/AC1, REQ-NFR-05/AC4)", () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it("REQ-NFR-05/AC4: always connects to a server by host and port, so WebdriverIO never starts a local driver or downloads a browser", async () => {
    await connectAppium("http://127.0.0.1:4723", { platformName: "Android" });
    await connectAppium(
      "https://hub-cloud.browserstack.com/wd/hub",
      { platformName: "iOS" },
      { user: "u", key: "k" },
    );
    await connectAppium("http://appium.internal", {});
    expect(calls.map((c) => [c["protocol"], c["hostname"], c["port"], c["path"]])).toEqual([
      ["http", "127.0.0.1", 4723, "/"],
      ["https", "hub-cloud.browserstack.com", 443, "/wd/hub"],
      ["http", "appium.internal", 80, "/"],
    ]);
    expect(calls[1]).toMatchObject({ user: "u", key: "k" });
  });
});
