import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "vitest";
import { androidSdkRoot, startAndroidEmulator, startAppium, type Exec, type Spawn } from "./emulator.js";

const fakeChild = () => {
  const signals: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signals,
    kill: (s: string) => {
      signals.push(s);
      return true;
    },
  });
  return child as unknown as ChildProcess & { exitCode: number | null; signals: string[] };
};

describe("Android emulator (REQ-ENV-06/AC2)", () => {
  it("REQ-ENV-06/AC2: creates a missing AVD, picks a free console port, waits for boot and stops only its emulator", async () => {
    const calls: string[] = [];
    let polls = 0;
    const exec: Exec = (cmd, args) => {
      calls.push([cmd.split("/").at(-1), ...args].join(" "));
      if (args[0] === "-list-avds") return Promise.resolve("other\n");
      if (args[0] === "devices") return Promise.resolve("List of devices attached\nemulator-5554\tdevice\n");
      if (args.includes("getprop")) return Promise.resolve((polls += 1) < 3 ? "\n" : "1\n");
      return Promise.resolve("");
    };
    const child = fakeChild();
    const spawned: string[][] = [];
    const spawn: Spawn = (cmd, args) => {
      spawned.push([cmd.split("/").at(-1) ?? "", ...args]);
      return child;
    };
    const emu = await startAndroidEmulator({
      sdkRoot: "/sdk",
      avd: "qajitsu",
      systemImage: "system-images;android-34;google_apis;arm64-v8a",
      headless: true,
      bootTimeoutMs: 60_000,
      exec,
      spawn,
      sleep: () => Promise.resolve(),
      avdmanager: "/sdk/avdmanager",
    });
    expect(emu.serial).toBe("emulator-5556");
    expect(calls).toContain(
      "avdmanager create avd --name qajitsu --package system-images;android-34;google_apis;arm64-v8a --force",
    );
    expect(spawned[0]).toEqual([
      "emulator",
      "-avd",
      "qajitsu",
      "-port",
      "5556",
      "-no-snapshot-save",
      "-no-boot-anim",
      "-no-audio",
      "-no-window",
    ]);
    await emu.stop();
    expect(calls.at(-1)).toBe("adb -s emulator-5556 emu kill");
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("REQ-ENV-06/AC2: an emulator that never boots is stopped and reported", async () => {
    const child = fakeChild();
    const exec: Exec = (_c, args) =>
      Promise.resolve(args[0] === "-list-avds" ? "qajitsu\n" : args[0] === "devices" ? "" : "0");
    const error = await startAndroidEmulator({
      sdkRoot: "/sdk",
      avd: "qajitsu",
      systemImage: "system-images;x",
      headless: false,
      bootTimeoutMs: 5,
      exec,
      spawn: () => child,
      sleep: () => new Promise((r) => setTimeout(r, 10)),
    }).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "EMULATOR_BOOT_TIMEOUT" });
    expect(child.signals).toEqual(["SIGTERM"]);
  });

  it("finds the SDK root from config, environment or the default", () => {
    expect(androidSdkRoot("/x")).toBe("/x");
    expect(androidSdkRoot()).toMatch(/sdk$/i);
  });
});

describe("Appium server (REQ-EXEC-06/AC1)", () => {
  it("starts on loopback and waits for /status; a server that never answers fails clearly", async () => {
    const child = fakeChild();
    let args: readonly string[] = [];
    let n = 0;
    const appium = await startAppium({
      bin: "appium",
      port: 4799,
      spawn: (_c, a) => {
        args = a;
        return child;
      },
      fetch: () => Promise.resolve(new Response("{}", { status: (n += 1) < 2 ? 503 : 200 })),
      sleep: () => Promise.resolve(),
    });
    expect(appium.url).toMatch(/^http:\/\/127\.0\.0\.1:4799\/qj-[0-9a-f]{32}$/);
    expect(args).toEqual([
      "--address",
      "127.0.0.1",
      "--port",
      "4799",
      "--base-path",
      new URL(appium.url).pathname,
      "--log-no-colors",
    ]);
    await appium.stop();
    const dead = fakeChild();
    dead.exitCode = 1;
    await expect(
      startAppium({
        bin: "appium",
        port: 1,
        spawn: () => dead,
        fetch: () => Promise.reject(new Error("refused")),
        sleep: () => Promise.resolve(),
      }),
    ).rejects.toMatchObject({ code: "APPIUM_START_FAILED" });
  });
});
