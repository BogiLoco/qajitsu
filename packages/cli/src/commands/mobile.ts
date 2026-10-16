import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { createServer } from "node:net";
import type { BrowserFactory } from "@qajitsu/adapter-runner-api";
import {
  androidSdkRoot,
  connectAppium,
  createAppiumDeviceFactory,
  startAndroidEmulator,
  startAppium,
  type RunningAppium,
} from "@qajitsu/adapter-runner-mobile";
import {
  AdapterError,
  mobileDevices,
  type CodeHost,
  type MobileConfig,
  type ProjectConfig,
} from "@qajitsu/core";
import { unzip } from "@qajitsu/report";
import type { RunSession } from "../session.js";
import { headlessFor } from "./live.js";

type AppSource = NonNullable<MobileConfig["android"]>["app"];

const globToRegExp = (glob: string): RegExp =>
  new RegExp(`(^|/)${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*")}$`);

/**
 * Runs the app build of the analysed branch: argument array, allowlisted environment and a throwaway
 * HOME inside the run's `env/`, so the branch's build script cannot read the user's dotfiles or keys.
 */
const runBuild = async (
  cmd: string,
  args: readonly string[],
  cwd: string,
  home: string,
  sdkRoot?: string,
): Promise<void> => {
  await mkdir(home, { recursive: true, mode: 0o700 });
  return new Promise((resolve, reject) => {
    const env = {
      ...Object.fromEntries(
        ["PATH", "TMPDIR", "LANG", "JAVA_HOME", "ANDROID_SDK_ROOT", "ANDROID_HOME"].flatMap((k) =>
          process.env[k] === undefined ? [] : [[k, process.env[k] ?? ""]],
        ),
      ),
      // The SDK is found before HOME is replaced (its default lives in the real home folder).
      ANDROID_SDK_ROOT: androidSdkRoot(sdkRoot),
      ANDROID_HOME: androidSdkRoot(sdkRoot),
      HOME: home,
    };
    execFile(cmd, [...args], { cwd, env, timeout: 1_800_000, maxBuffer: 64 * 1024 * 1024 }, (e, _o, err) => {
      if (e) reject(new AdapterError("APP_BUILD_FAILED", `App build failed: ${err.slice(-500)}`, {}));
      else resolve();
    });
  });
};

/** Resolves a file of the worktree and refuses one that leaves it, also through symlinks. */
const insideWorktree = async (worktree: string, file: string): Promise<string> => {
  const root = await realpath(worktree);
  const target = await realpath(file).catch(() => undefined);
  const rel = target === undefined ? undefined : relative(root, target);
  if (rel === undefined || rel.startsWith("..") || isAbsolute(rel))
    throw new AdapterError("APP_NOT_FOUND", `App binary ${basename(file)} not found in the worktree.`, {});
  return target ?? file;
};

/**
 * Finds the app binary for the analysed SHA (REQ-ENV-06/AC1): a CI artifact of exactly that commit
 * (GitHub Actions or GitLab CI), a file in the run's worktree, or a build command run in the worktree.
 * Downloads go to the run's `env/app/` (removed by cleanup).
 *
 * @throws {AdapterError} `APP_NOT_FOUND`, `APP_BUILD_FAILED` or the code host's artifact errors.
 */
export async function resolveAppBinary(
  session: RunSession,
  app: AppSource,
  codeHosts: Readonly<Record<string, CodeHost>>,
  config: ProjectConfig,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<string | undefined> {
  const { ws } = session;
  // REQ-EXEC-23/AC1: an app without its repository.
  if (app.source === "installed") return undefined;
  if (app.source === "file") {
    const file = isAbsolute(app.path) ? app.path : join(session.project.projectDir, app.path);
    if (
      !(await stat(file).then(
        (st) => st.isFile() || st.isDirectory(),
        () => false,
      ))
    )
      throw new AdapterError("APP_NOT_FOUND", `App binary ${basename(file)} not found.`, {});
    return file;
  }
  if (app.source === "url") {
    const url = new URL(app.url);
    // The same allowlist as everything else the framework calls (invariant 10).
    if (!config.environments.allowlist.some((a) => new URL(a).origin === url.origin))
      throw new AdapterError(
        "APP_NOT_FOUND",
        `App download host ${url.origin} is not in environments.allowlist.`,
        {},
      );
    const response = await fetchFn(url, { redirect: "error" }).catch((error: unknown) => {
      throw new AdapterError(
        "APP_NOT_FOUND",
        `App download failed: ${error instanceof Error ? error.message : String(error)}`,
        {},
      );
    });
    if (!response.ok)
      throw new AdapterError("APP_NOT_FOUND", `App download failed: HTTP ${String(response.status)}.`, {});
    const data = new Uint8Array(await response.arrayBuffer());
    const actual = createHash("sha256").update(data).digest("hex");
    // REQ-EXEC-23/AC3: a different file is never installed.
    if (actual !== app.sha256)
      throw new AdapterError(
        "APP_CHECKSUM_MISMATCH",
        `App download has SHA-256 ${actual}, the configuration expects ${app.sha256}.`,
        {},
      );
    await mkdir(ws.path("env", "app"), { recursive: true, mode: 0o700 });
    const file = ws.path("env", "app", basename(url.pathname) || "app.bin");
    await writeFile(file, data);
    return file;
  }
  const repoRecord = ws.record.repos[app.repo];
  if (!repoRecord)
    throw new AdapterError("APP_NOT_FOUND", `Repository '${app.repo}' was not fetched for this run.`, {
      repo: app.repo,
    });
  const worktree = ws.path("repos", app.repo);
  if (app.source === "path" || app.source === "build") {
    if (app.source === "build") {
      const [cmd, ...args] = app.command;
      await runBuild(
        cmd === "node" ? process.execPath : (cmd ?? ""),
        args,
        worktree,
        ws.path("env", "build-home"),
        config.mobile?.android?.sdk_root,
      );
    }
    const file = await insideWorktree(
      worktree,
      ws.path("repos", app.repo, app.source === "path" ? app.path : app.output),
    );
    if (
      !(await stat(file).then(
        (st) => st.isFile(),
        () => false,
      ))
    )
      throw new AdapterError("APP_NOT_FOUND", `App binary ${basename(file)} not found in the worktree.`, {});
    return file;
  }
  const repo = config.repos[app.repo];
  const host = repo ? codeHosts[repo.host] : undefined;
  if (!repo || !host?.downloadArtifact)
    throw new AdapterError("APP_NOT_FOUND", `Code host of '${app.repo}' cannot download CI artifacts.`, {});
  const archive = await host.downloadArtifact(repo.path, repoRecord.sha, app.artifact);
  const pattern = globToRegExp(app.file);
  const entry = unzip(archive, { maxEntryBytes: 500_000_000, maxTotalBytes: 1_000_000_000 }).find((e) =>
    pattern.test(e.name),
  );
  if (!entry) throw new AdapterError("APP_NOT_FOUND", `No ${app.file} in artifact '${app.artifact}'.`, {});
  await mkdir(ws.path("env", "app"), { recursive: true, mode: 0o700 });
  const file = ws.path("env", "app", basename(entry.name));
  await writeFile(file, entry.data);
  return file;
}

/** Output of a tool, or undefined when it cannot run. */
const toolOutput = (cmd: string, args: readonly string[]): Promise<string | undefined> =>
  new Promise((done) => {
    execFile(cmd, [...args], { timeout: 30_000, maxBuffer: 16 * 1024 * 1024 }, (e, out) => {
      done(e ? undefined : out);
    });
  });

/**
 * The version of an Android app, when it can be read (REQ-EXEC-23/AC2): from the APK with the SDK's `aapt2`, or from
 * the device with `adb dumpsys package` for an installed app. Undefined when neither works.
 *
 * @param sdkRoot - Android SDK root.
 * @param target - The APK, or the device serial and app id.
 */
export async function androidAppVersion(
  sdkRoot: string,
  target: { readonly apk: string } | { readonly serial: string; readonly appId: string },
  run: (cmd: string, args: readonly string[]) => Promise<string | undefined> = toolOutput,
): Promise<string | undefined> {
  if ("apk" in target) {
    const tools = await readdir(join(sdkRoot, "build-tools")).catch(() => [] as string[]);
    const latest = tools.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).at(-1);
    if (latest === undefined) return undefined;
    const out = await run(join(sdkRoot, "build-tools", latest, "aapt2"), ["dump", "badging", target.apk]);
    return /versionName='([^']+)'/.exec(out ?? "")?.[1];
  }
  const out = await run(join(sdkRoot, "platform-tools", "adb"), [
    "-s",
    target.serial,
    "shell",
    "dumpsys",
    "package",
    target.appId,
  ]);
  return /versionName=(\S+)/.exec(out ?? "")?.[1];
}

/** SHA-256 of an app file; undefined for an app folder (`.app`) or no file. */
const fileSha256 = async (file: string | undefined): Promise<string | undefined> => {
  if (
    file === undefined ||
    !(await stat(file).then(
      (st) => st.isFile(),
      () => false,
    ))
  )
    return undefined;
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
};

/** The app a run tested (REQ-EXEC-23/AC2), kept in `run.json` and shown in the report. */
export interface TestedApp {
  readonly platform: "android" | "ios";
  readonly id: string;
  readonly source: string;
  readonly sha256?: string | undefined;
  readonly version?: string | undefined;
}

/** Records the tested app in `run.json` and the journal. */
async function recordApp(session: RunSession, app: TestedApp): Promise<void> {
  const clean = Object.fromEntries(Object.entries(app).filter(([, v]) => v !== undefined));
  await session.ws.update({ data: { ...session.ws.record.data, app: clean } });
  session.events.emit("run", { kind: "system", name: "orchestrator" }, "mobile.app", clean);
}

/** A device ready for mobile cases, or the reason they are BLOCKED. */
export type PreparedMobile =
  | {
      readonly ok: true;
      /** One factory per device that started (REQ-EXEC-10/AC2, REQ-EXEC-20). */
      readonly factories: readonly BrowserFactory[];
      /** Name of each device of `factories`, e.g. `pixel-8` (default `device-<n>`). */
      readonly names?: readonly string[];
      /** Devices that did not start, with the reason (REQ-EXEC-20/AC4). */
      readonly failed?: readonly { readonly name: string; readonly reason: string }[];
      /** The first configured device: the primary run in matrix mode. */
      readonly primary?: string;
      readonly stop: () => Promise<void>;
    }
  | { readonly ok: false; readonly reason: string };

const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const s = createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => {
        resolve(port);
      });
    });
  });

/** The environment URL as an Android emulator sees it: the host's loopback is 10.0.2.2. */
export const emulatorUrl = (baseUrl: string): string =>
  baseUrl.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost)(?=[:/]|$)/, "$110.0.2.2");

/**
 * Prepares the device for the run's mobile cases (REQ-EXEC-06, REQ-ENV-06): Android with an emulator
 * QAJitsu starts and stops, or iOS through a device farm. When a platform is not available on this
 * machine the cases are BLOCKED with a clear reason instead of failing the run (REQ-ENV-06/AC3).
 */
export async function prepareMobile(
  session: RunSession,
  baseUrl: string,
  codeHosts: Readonly<Record<string, CodeHost>>,
  appiumHome: string | undefined,
  options: {
    readonly allowBuild: boolean;
    readonly headed?: boolean;
    /** Downloads of `source: url` apps (default: global fetch). */
    readonly fetch?: typeof globalThis.fetch;
  } = { allowBuild: false },
): Promise<PreparedMobile> {
  const { project } = session;
  const mobile = project.config.mobile;
  if (!mobile) return { ok: false, reason: "mobile cases need the mobile section in .qa/qa.project.yaml" };
  const stops: (() => Promise<void>)[] = [];
  const stop = async (): Promise<void> => {
    for (const s of stops.reverse()) await s().catch(() => undefined);
  };
  try {
    if (mobile.android) {
      const android = mobile.android;
      // A build runs the analysed branch's code on this machine: only with an explicit --build.
      if (android.app.source === "build" && !options.allowBuild)
        return {
          ok: false,
          reason: "the app is built from the analysed branch only with --build (it runs the branch's code)",
        };
      const launchUrl = emulatorUrl(baseUrl);
      if (!/^https?:\/\/[\w.-]+(:\d+)?(\/[\w./-]*)?$/.test(launchUrl))
        return { ok: false, reason: "the environment URL cannot be passed to the app launch safely" };
      const app = await resolveAppBinary(session, android.app, codeHosts, project.config, options.fetch);
      if (mobile.devices > 1 && !android.emulator && !android.emulators)
        return {
          ok: false,
          reason: "mobile.devices > 1 needs mobile.android.emulator (QAJitsu starts one emulator per device)",
        };
      const list = mobileDevices(mobile);
      // Started one after another: each emulator picks a console port the ones before it do not use. A device that
      // does not start is reported with the reason; the others go on (REQ-EXEC-20/AC4).
      const started: { name: string; serial?: string }[] = [];
      const failed: { name: string; reason: string }[] = [];
      for (const d of list) {
        if (d.kind !== "emulator") {
          started.push({ name: d.name });
          continue;
        }
        try {
          const emulator = await startAndroidEmulator({
            sdkRoot: androidSdkRoot(android.sdk_root),
            avd: d.profile.avd,
            systemImage: d.profile.system_image,
            ...(d.profile.device ? { deviceProfile: d.profile.device } : {}),
            headless: headlessFor(d.profile.headless, { headed: options.headed === true }),
            bootTimeoutMs: d.profile.boot_timeout_s * 1000,
            readOnly: d.readOnly,
          });
          stops.push(() => emulator.stop());
          started.push({ name: d.name, serial: emulator.serial });
        } catch (error) {
          failed.push({
            name: d.name,
            reason: session.masker.maskText(error instanceof Error ? error.message : String(error)),
          });
        }
      }
      if (started.length === 0) {
        await stop();
        return { ok: false, reason: failed.map((f) => `${f.name}: ${f.reason}`).join("; ") };
      }
      // REQ-EXEC-23/AC2: which app the run tested, in place of a commit when there is no code.
      const sdk = androidSdkRoot(android.sdk_root);
      const firstSerial = started.find((d) => d.serial !== undefined)?.serial;
      await recordApp(session, {
        platform: "android",
        id: android.app_id,
        source: android.app.source,
        sha256: await fileSha256(app),
        version: await androidAppVersion(
          sdk,
          app !== undefined
            ? { apk: app }
            : { serial: firstSerial ?? "emulator-5554", appId: android.app_id },
        ).catch(() => undefined),
      });
      const appium = await appiumServer(mobile, project.qaDir, appiumHome, sdk);
      if (appium.stop) stops.push(appium.stop);
      const factories: BrowserFactory[] = [];
      for (const device of started) {
        // Parallel UiAutomator2 sessions on one Appium server need their own system port.
        const systemPort = list.length > 1 ? await freePort() : undefined;
        factories.push(
          createAppiumDeviceFactory({
            platform: "android",
            connect: (caps) => connectAppium(appium.url, caps),
            capabilities: {
              platformName: "Android",
              "appium:automationName": "UiAutomator2",
              // REQ-EXEC-23/AC1: an installed app is started by its id, nothing is installed.
              ...(app === undefined ? { "appium:noReset": true } : { "appium:app": app }),
              "appium:appPackage": android.app_id,
              ...(android.activity ? { "appium:appActivity": android.activity } : {}),
              ...(device.serial ? { "appium:udid": device.serial } : {}),
              ...(systemPort === undefined ? {} : { "appium:systemPort": systemPort }),
              ...(android.intent_args
                ? {
                    "appium:optionalIntentArguments": android.intent_args.replaceAll(
                      "{{base_url}}",
                      launchUrl,
                    ),
                  }
                : {}),
              "appium:newCommandTimeout": 120,
            },
            recording: mobile.recording,
            deepLinkScheme: android.deep_link_scheme,
            appId: android.app_id,
            actionTimeoutMs: mobile.action_timeout_ms,
          }),
        );
      }
      return {
        ok: true,
        factories,
        names: started.map((d) => d.name),
        failed,
        ...(list[0] ? { primary: list[0].name } : {}),
        stop,
      };
    }
    const ios = mobile.ios;
    if (!ios) return { ok: false, reason: "mobile cases need mobile.android or mobile.ios" };
    if (!ios.farm)
      return {
        ok: false,
        reason:
          platform() === "darwin"
            ? "iOS without a device farm needs Xcode and the XCUITest driver on this Mac; configure mobile.ios.farm to use a device farm"
            : "iOS needs macOS with Xcode or a device farm (mobile.ios.farm: browserstack or saucelabs)",
      };
    const farm = ios.farm;
    const user = await session.resolveSecret(farm.username);
    const key = await session.resolveSecret(farm.access_key);
    const hub =
      farm.provider === "browserstack"
        ? "https://hub-cloud.browserstack.com/wd/hub"
        : "https://ondemand.us-west-1.saucelabs.com/wd/hub";
    const devices = mobileDevices(mobile).filter((d) => d.kind === "farm");
    const factory = (device: { device: string; osVersion: string }): BrowserFactory =>
      createAppiumDeviceFactory({
        platform: "ios",
        connect: (caps) => connectAppium(hub, caps, { user, key }),
        capabilities: farmCapabilities(farm, ios.bundle_id, device),
        // The farm credentials are masked in device logs, page source and connection errors.
        secrets: [user, key],
        recording: mobile.recording,
        deepLinkScheme: ios.deep_link_scheme,
        appId: ios.bundle_id,
        actionTimeoutMs: mobile.action_timeout_ms,
      });
    // One farm session per device (REQ-EXEC-20/AC1).
    return {
      ok: true,
      factories: devices.map((d) => factory(d)),
      names: devices.map((d) => d.name),
      ...(devices[0] ? { primary: devices[0].name } : {}),
      stop,
    };
  } catch (error) {
    await stop();
    return {
      ok: false,
      reason: session.masker.maskText(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * W3C capabilities for an iOS device farm session. The app is the farm's upload id (`bs://...`,
 * `storage:...`); no local path leaves the machine. Vendor-side recording is off unless configured.
 */
export function farmCapabilities(
  farm: NonNullable<NonNullable<MobileConfig["ios"]>["farm"]>,
  bundleId: string,
  /** The device of a device list (REQ-EXEC-20); default the farm's one device. */
  device: { readonly device: string; readonly osVersion: string } = {
    device: farm.device ?? "",
    osVersion: farm.os_version ?? "",
  },
): Record<string, unknown> {
  const record = farm.vendor_recording;
  const common = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:app": farm.app,
    "appium:bundleId": bundleId,
    "appium:deviceName": device.device,
    "appium:platformVersion": device.osVersion,
  };
  return farm.provider === "browserstack"
    ? { ...common, "bstack:options": { projectName: "QAJitsu", video: record, deviceLogs: record } }
    : { ...common, "sauce:options": { name: "QAJitsu", recordVideo: record, recordLogs: record } };
}

async function appiumServer(
  mobile: MobileConfig,
  qaDir: string,
  appiumHome: string | undefined,
  sdkRoot: string,
): Promise<{ url: string; stop?: () => Promise<void> }> {
  if (mobile.appium.url) return { url: mobile.appium.url };
  const running: RunningAppium = await startAppium({
    bin:
      mobile.appium.bin?.includes("/") === true
        ? resolve(qaDir, mobile.appium.bin)
        : (mobile.appium.bin ?? "appium"),
    port: await freePort(),
    env: {
      ANDROID_SDK_ROOT: sdkRoot,
      ANDROID_HOME: sdkRoot,
      ...(mobile.appium.home
        ? { APPIUM_HOME: resolve(qaDir, mobile.appium.home) }
        : appiumHome
          ? { APPIUM_HOME: appiumHome }
          : {}),
    },
    timeoutMs: 120_000,
  });
  return { url: running.url, stop: () => running.stop() };
}
