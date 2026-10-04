import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { AdapterError } from "@qajitsu/core";

/** Runs a command with an argument array and returns stdout. */
export type Exec = (
  cmd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => Promise<string>;
/** Starts a long-running process (emulator, Appium). */
export type Spawn = (
  cmd: string,
  args: readonly string[],
  env?: Readonly<Record<string, string>>,
) => ChildProcess;

const ENV_KEYS = ["PATH", "HOME", "TMPDIR", "USER", "LANG", "JAVA_HOME", "ANDROID_SDK_ROOT", "ANDROID_HOME"];
const baseEnv = (): Record<string, string> =>
  Object.fromEntries(
    ENV_KEYS.flatMap((k) => (process.env[k] === undefined ? [] : [[k, process.env[k] ?? ""]])),
  );

/** Default {@link Exec} on `execFile` with an allowlisted environment. */
export const execTool: Exec = (cmd, args, env = {}) =>
  new Promise((resolve, reject) => {
    const child = execFile(
      cmd,
      [...args],
      { env: { ...baseEnv(), ...env }, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
      (e, out, err) => {
        if (e)
          reject(
            new AdapterError(
              "TOOL_FAILED",
              `${cmd.split("/").at(-1) ?? cmd} ${args[0] ?? ""} failed: ${err.slice(-500)}`,
              {},
            ),
          );
        else resolve(out);
      },
    );
    // Tools that ask (avdmanager: "custom hardware profile?") get "no" and EOF instead of waiting forever.
    child.stdin?.end("no\n");
  });

/**
 * Default {@link Spawn} with an allowlisted environment. Output is discarded: an undrained pipe would
 * block a chatty server (Appium) mid-case and turn into failures unrelated to the app.
 */
export const spawnTool: Spawn = (cmd, args, env = {}) =>
  spawn(cmd, [...args], { env: { ...baseEnv(), ...env }, stdio: "ignore" });

/** Resolves the Android SDK root: config, `$ANDROID_SDK_ROOT`, `$ANDROID_HOME`, then the macOS default. */
export function androidSdkRoot(configured?: string): string {
  return (
    configured ??
    process.env["ANDROID_SDK_ROOT"] ??
    process.env["ANDROID_HOME"] ??
    join(homedir(), "Library", "Android", "sdk")
  );
}

/** A running emulator. */
export interface RunningEmulator {
  /** adb serial, e.g. `emulator-5556`. */
  readonly serial: string;
  /** Stops the emulator (also when it was started by a run that failed). */
  stop(): Promise<void>;
}

/** Settings of {@link startAndroidEmulator}. */
export interface EmulatorOptions {
  readonly sdkRoot: string;
  readonly avd: string;
  readonly systemImage: string;
  readonly headless: boolean;
  readonly bootTimeoutMs: number;
  readonly exec?: Exec;
  readonly spawn?: Spawn;
  readonly sleep?: (ms: number) => Promise<void>;
  /** avdmanager binary; default `cmdline-tools/latest/bin/avdmanager` in the SDK, else `avdmanager` on PATH. */
  readonly avdmanager?: string;
}

/**
 * Starts an Android emulator for a run and waits until it has booted (REQ-ENV-06/AC2). The AVD is
 * created from the system image when missing. A free even console port is chosen among the ones adb does
 * not list, so runs on one machine do not clash; `stop()` kills that emulator only.
 *
 * @throws {AdapterError} `EMULATOR_BOOT_TIMEOUT` when the device does not finish booting in time.
 */
export async function startAndroidEmulator(options: EmulatorOptions): Promise<RunningEmulator> {
  const exec = options.exec ?? execTool;
  const start = options.spawn ?? spawnTool;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const env = { ANDROID_SDK_ROOT: options.sdkRoot, ANDROID_HOME: options.sdkRoot };
  const adb = join(options.sdkRoot, "platform-tools", "adb");
  const emulator = join(options.sdkRoot, "emulator", "emulator");
  const sdkAvdmanager = join(options.sdkRoot, "cmdline-tools", "latest", "bin", "avdmanager");
  const avdmanager = options.avdmanager ?? (existsSync(sdkAvdmanager) ? sdkAvdmanager : "avdmanager");

  const avds = (await exec(emulator, ["-list-avds"], env)).split("\n").map((l) => l.trim());
  if (!avds.includes(options.avd))
    await exec(
      avdmanager,
      ["create", "avd", "--name", options.avd, "--package", options.systemImage, "--force"],
      {
        ...env,
        // "Do you wish to create a custom hardware profile?" is answered by the empty stdin.
      },
    );
  const used = new Set(
    [...(await exec(adb, ["devices"], env)).matchAll(/emulator-(\d+)/g)].map((m) => Number(m[1])),
  );
  let port = 5554;
  while (used.has(port)) port += 2;
  const serial = `emulator-${String(port)}`;
  const child = start(
    emulator,
    [
      "-avd",
      options.avd,
      "-port",
      String(port),
      "-no-snapshot-save",
      "-no-boot-anim",
      "-no-audio",
      ...(options.headless ? ["-no-window"] : []),
    ],
    env,
  );
  const stop = async (): Promise<void> => {
    await exec(adb, ["-s", serial, "emu", "kill"], env).catch(() => undefined);
    child.kill("SIGTERM");
  };
  const deadline = Date.now() + options.bootTimeoutMs;
  while (Date.now() < deadline) {
    const booted = await exec(adb, ["-s", serial, "shell", "getprop", "sys.boot_completed"], env).catch(
      () => "",
    );
    if (booted.trim() === "1") return { serial, stop };
    if (child.exitCode !== null) break;
    await sleep(2000);
  }
  await stop();
  throw new AdapterError(
    "EMULATOR_BOOT_TIMEOUT",
    `Emulator ${options.avd} did not boot within ${String(options.bootTimeoutMs / 1000)} s.`,
    { avd: options.avd },
  );
}

/** A running Appium server. */
export interface RunningAppium {
  readonly url: string;
  stop(): Promise<void>;
}

/**
 * Starts an Appium server on a free port and waits for `/status` (REQ-EXEC-06/AC1).
 *
 * @throws {AdapterError} `APPIUM_START_FAILED` when it does not answer in time.
 */
export async function startAppium(options: {
  readonly bin: string;
  readonly port: number;
  readonly env?: Readonly<Record<string, string>>;
  readonly spawn?: Spawn;
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly sleep?: (ms: number) => Promise<void>;
}): Promise<RunningAppium> {
  const start = options.spawn ?? spawnTool;
  const fetch = options.fetch ?? globalThis.fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Appium has no authentication and the emulator reaches the host's loopback (10.0.2.2): a random
  // base path keeps the app under test from opening its own sessions on this server.
  const basePath = `/qj-${randomBytes(16).toString("hex")}`;
  const url = `http://127.0.0.1:${String(options.port)}${basePath}`;
  const child = start(
    options.bin,
    ["--address", "127.0.0.1", "--port", String(options.port), "--base-path", basePath, "--log-no-colors"],
    options.env,
  );
  const stop = (): Promise<void> => {
    child.kill("SIGTERM");
    return Promise.resolve();
  };
  const deadline = Date.now() + (options.timeoutMs ?? 60_000);
  while (Date.now() < deadline) {
    const ok = await fetch(`${url}/status`, { signal: AbortSignal.timeout(2000) }).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return { url, stop };
    if (child.exitCode !== null) break;
    await sleep(500);
  }
  await stop();
  throw new AdapterError("APPIUM_START_FAILED", "The Appium server did not start.", {});
}
