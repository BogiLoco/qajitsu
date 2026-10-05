import { execFile } from "node:child_process";
import { mkdir, realpath, stat, writeFile } from "node:fs/promises";
import { platform } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { createServer } from "node:net";
import type { BrowserFactory } from "@qajitsu/adapter-runner-api";
import {
  androidSdkRoot,
  connectAppium,
  createAppiumDeviceFactory,
  startAndroidEmulator,
  startAppium,
  type RunningAppium,
  type RunningEmulator,
} from "@qajitsu/adapter-runner-mobile";
import { AdapterError, type CodeHost, type MobileConfig, type ProjectConfig } from "@qajitsu/core";
import { unzip } from "@qajitsu/report";
import type { RunSession } from "../session.js";

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
): Promise<string> {
  const { ws } = session;
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

/** A device ready for mobile cases, or the reason they are BLOCKED. */
export type PreparedMobile =
  | {
      readonly ok: true;
      /** One factory per device; cases are split among them (REQ-EXEC-10/AC2). */
      readonly factories: readonly BrowserFactory[];
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
  options: { readonly allowBuild: boolean } = { allowBuild: false },
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
      const app = await resolveAppBinary(session, android.app, codeHosts, project.config);
      if (mobile.devices > 1 && !android.emulator)
        return {
          ok: false,
          reason: "mobile.devices > 1 needs mobile.android.emulator (QAJitsu starts one emulator per device)",
        };
      // Started one after another: each emulator picks a console port the ones before it do not use.
      const emulators: RunningEmulator[] = [];
      if (android.emulator) {
        for (let i = 0; i < mobile.devices; i++) {
          const emulator = await startAndroidEmulator({
            sdkRoot: androidSdkRoot(android.sdk_root),
            avd: android.emulator.avd,
            systemImage: android.emulator.system_image,
            headless: android.emulator.headless,
            bootTimeoutMs: android.emulator.boot_timeout_s * 1000,
            readOnly: mobile.devices > 1,
          });
          emulators.push(emulator);
          stops.push(() => emulator.stop());
        }
      }
      const appium = await appiumServer(mobile, project.qaDir, appiumHome, androidSdkRoot(android.sdk_root));
      if (appium.stop) stops.push(appium.stop);
      const factories: BrowserFactory[] = [];
      for (const emulator of emulators.length > 0 ? emulators : [undefined]) {
        // Parallel UiAutomator2 sessions on one Appium server need their own system port.
        const systemPort = mobile.devices > 1 ? await freePort() : undefined;
        factories.push(
          createAppiumDeviceFactory({
            platform: "android",
            connect: (caps) => connectAppium(appium.url, caps),
            capabilities: {
              platformName: "Android",
              "appium:automationName": "UiAutomator2",
              "appium:app": app,
              "appium:appPackage": android.app_id,
              ...(android.activity ? { "appium:appActivity": android.activity } : {}),
              ...(emulator ? { "appium:udid": emulator.serial } : {}),
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
      return { ok: true, factories, stop };
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
    const factory = (): BrowserFactory =>
      createAppiumDeviceFactory({
        platform: "ios",
        connect: (caps) => connectAppium(hub, caps, { user, key }),
        capabilities: farmCapabilities(farm, ios.bundle_id),
        // The farm credentials are masked in device logs, page source and connection errors.
        secrets: [user, key],
        recording: mobile.recording,
        deepLinkScheme: ios.deep_link_scheme,
        appId: ios.bundle_id,
        actionTimeoutMs: mobile.action_timeout_ms,
      });
    // One farm session per device.
    return { ok: true, factories: Array.from({ length: mobile.devices }, factory), stop };
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
): Record<string, unknown> {
  const record = farm.vendor_recording;
  const common = {
    platformName: "iOS",
    "appium:automationName": "XCUITest",
    "appium:app": farm.app,
    "appium:bundleId": bundleId,
    "appium:deviceName": farm.device,
    "appium:platformVersion": farm.os_version,
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
