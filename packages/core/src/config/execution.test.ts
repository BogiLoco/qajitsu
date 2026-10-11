import { describe, expect, it } from "vitest";
import { mobileDevices } from "./mobile.js";
import { laneWorkers, parseProjectConfig } from "./project-config.js";

const base = { project: "shop", jira: { type: "file", tickets_dir: "t", project_key: "SHOP" } };
const image = (api: number) => `system-images;android-${String(api)};google_apis;arm64-v8a`;
const android = (extra: Record<string, unknown>) => ({
  app: { source: "path", repo: "shop", path: "a.apk" },
  app_id: "a.b",
  ...extra,
});

describe("execution lanes (REQ-EXEC-19)", () => {
  it("REQ-EXEC-19/AC1: workers per lane default to environments.workers", () => {
    expect(laneWorkers(parseProjectConfig({ ...base, environments: { workers: 3 } }))).toEqual({
      api: 3,
      web: 3,
      webCombinations: 1,
      sequential: false,
    });
    const config = parseProjectConfig({
      ...base,
      execution: { workers: { api: 6, web: 2 }, web_combinations: 2 },
    });
    expect(laneWorkers(config)).toEqual({ api: 6, web: 2, webCombinations: 2, sequential: false });
  });

  it("REQ-EXEC-19/AC2: sequential, from the config or the flag, is one case at a time everywhere", () => {
    const busy = { ...base, execution: { workers: { api: 6, web: 2 }, web_combinations: 3 } };
    const one = { api: 1, web: 1, webCombinations: 1, sequential: true };
    expect(laneWorkers(parseProjectConfig(busy), { sequential: true })).toEqual(one);
    expect(
      laneWorkers(parseProjectConfig({ ...busy, execution: { ...busy.execution, sequential: true } })),
    ).toEqual(one);
    expect(() => parseProjectConfig({ ...base, execution: { workers: { api: 0 } } })).toThrow();
    expect(parseProjectConfig(base).execution.account_wait_s).toBe(300);
  });
});

describe("several mobile devices (REQ-EXEC-20)", () => {
  it("REQ-EXEC-20/AC1: a list of different emulators, each its own device with its hardware profile", () => {
    const config = parseProjectConfig({
      ...base,
      mobile: {
        distribute: "matrix",
        android: android({
          emulators: [
            { name: "pixel-8", avd: "qj-pixel", system_image: image(34), device: "pixel_8" },
            { name: "small", avd: "qj-small", system_image: image(30) },
          ],
        }),
      },
    });
    expect(config.mobile?.distribute).toBe("matrix");
    expect(mobileDevices(config.mobile ?? ({} as never))).toEqual([
      {
        name: "pixel-8",
        kind: "emulator",
        readOnly: false,
        profile: {
          name: "pixel-8",
          avd: "qj-pixel",
          system_image: image(34),
          device: "pixel_8",
          headless: true,
          boot_timeout_s: 300,
        },
      },
      expect.objectContaining({ name: "small", kind: "emulator", readOnly: false }),
    ]);
  });

  it("REQ-EXEC-10/AC2: copies of one emulator share its AVD read-only; one connected device; farm sessions", () => {
    const copies = parseProjectConfig({
      ...base,
      mobile: { devices: 2, android: android({ emulator: { system_image: image(34) } }) },
    }).mobile;
    expect(
      mobileDevices(copies ?? ({} as never)).map((d) => [d.name, d.kind, "readOnly" in d && d.readOnly]),
    ).toEqual([
      ["emulator-1", "emulator", true],
      ["emulator-2", "emulator", true],
    ]);
    const connected = parseProjectConfig({ ...base, mobile: { android: android({}) } }).mobile;
    expect(mobileDevices(connected ?? ({} as never))).toEqual([{ name: "device", kind: "connected" }]);
    const farm = {
      provider: "browserstack",
      app: "bs://abc",
      username: "secret://env/BS_USER",
      access_key: "secret://env/BS_KEY",
    };
    const one = parseProjectConfig({
      ...base,
      mobile: {
        devices: 2,
        ios: { bundle_id: "a.b", farm: { ...farm, device: "iPhone 15", os_version: "17" } },
      },
    }).mobile;
    expect(mobileDevices(one ?? ({} as never))).toEqual([
      { name: "farm-1", kind: "farm", device: "iPhone 15", osVersion: "17" },
      { name: "farm-2", kind: "farm", device: "iPhone 15", osVersion: "17" },
    ]);
    const many = parseProjectConfig({
      ...base,
      mobile: {
        ios: {
          bundle_id: "a.b",
          farm: {
            ...farm,
            devices: [
              { name: "iphone-15", device: "iPhone 15", os_version: "17" },
              { name: "ipad", device: "iPad Air", os_version: "16" },
            ],
          },
        },
      },
    }).mobile;
    expect(mobileDevices(many ?? ({} as never)).map((d) => d.name)).toEqual(["iphone-15", "ipad"]);
    expect(mobileDevices({ ...(many ?? ({} as never)), ios: undefined })).toEqual([]);
  });

  it("REQ-EXEC-20/AC1: one way to describe the devices, each name once", () => {
    const issues = (mobile: Record<string, unknown>): string[] => {
      try {
        parseProjectConfig({ ...base, repos: {}, mobile });
        return [];
      } catch (error) {
        return (error as { context: { issues: string[] } }).context.issues;
      }
    };
    const twin = { name: "pixel", avd: "a", system_image: image(34) };
    expect(
      issues({
        devices: 2,
        android: android({ emulator: { system_image: image(34) }, emulators: [twin, { ...twin, avd: "b" }] }),
      }),
    ).toEqual([
      "mobile.android: use emulators (several devices) or emulator (one profile), not both",
      "mobile.devices: does not apply with mobile.android.emulators; list one profile per device",
      "mobile: device name 'pixel' is used twice",
    ]);
    expect(() =>
      parseProjectConfig({
        ...base,
        mobile: {
          ios: {
            bundle_id: "a.b",
            farm: {
              provider: "saucelabs",
              app: "storage:abc",
              username: "secret://env/U",
              access_key: "secret://env/K",
              device: "iPhone 15",
            },
          },
        },
      }),
    ).toThrow();
    expect(issues({ android: android({ emulators: [{ ...twin, name: "Pixel 8" }] }) })).toEqual([
      "mobile.android.emulators.0.name: Device names look like pixel-8 or tablet",
    ]);
  });
});
