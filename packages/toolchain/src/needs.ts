import { mobileDevices, webCombinations, type ProjectConfig } from "@qajitsu/core";
import type { ToolchainFile } from "./config.js";
import { ANDROID_DEFAULTS, type ToolId } from "./manifest.js";

/** One emulator a project starts: its AVD, system image and hardware profile. */
export interface EmulatorNeed {
  readonly avd: string;
  readonly systemImage: string;
  /** avdmanager hardware profile, e.g. `pixel_8`. */
  readonly device?: string | undefined;
}

/** The Android SDK packages a project needs and its emulators. */
export interface AndroidNeeds {
  /** sdkmanager package ids, e.g. `platform-tools`, `platforms;android-34`. */
  readonly packages: readonly string[];
  /** One entry per AVD, in device order (REQ-EXEC-20/AC5); empty without an emulator. */
  readonly emulators: readonly EmulatorNeed[];
  /** Emulators that run at the same time, for the memory precheck. */
  readonly atOnce: number;
}

/** What a project needs from the toolchain, and why (REQ-GEN-06/AC1). */
export interface ToolchainNeeds {
  /** Each needed tool with the reason, e.g. "web tests". */
  readonly tools: ReadonlyMap<ToolId, string>;
  /** Browsers of the web matrix. */
  readonly browsers: readonly string[];
  readonly android?: AndroidNeeds;
}

/**
 * Derives the tools a project needs from its `.qa/` configuration (REQ-GEN-06/AC1): browsers of the web matrix,
 * Docker for compose services, Java and the Android SDK packages for Android (platform and build tools only when the
 * app is built from the worktree, the emulator and its system image when one is configured), Appium and its drivers
 * when QAJitsu starts the server, Xcode for local iOS runs.
 *
 * @param config - The project's configuration.
 * @param versions - Versions from `toolchain.yaml` (Android platform and build tools).
 */
export function toolchainNeeds(config: ProjectConfig, versions: ToolchainFile["versions"]): ToolchainNeeds {
  const tools = new Map<ToolId, string>();
  const browsers = config.test_types.includes("web")
    ? [...new Set(webCombinations(config.web).map((c) => c.browser))].sort()
    : [];
  if (browsers.length > 0) tools.set("browsers", "web tests");
  if (Object.values(config.services).some((s) => s.kind !== "process"))
    tools.set("docker", "--build with compose services");
  const mobile = config.mobile;
  let android: AndroidNeeds | undefined;
  if (mobile?.android) {
    tools.set("java", "Android tests");
    tools.set("android", "Android tests");
    const platform = versions.android?.platform ?? ANDROID_DEFAULTS.platform;
    const buildTools = versions.android?.build_tools ?? ANDROID_DEFAULTS.buildTools;
    const devices = mobileDevices(mobile).flatMap((d) => (d.kind === "emulator" ? [d.profile] : []));
    // Copies of one emulator share its AVD: one entry per AVD.
    const emulators = [...new Map(devices.map((p) => [p.avd, p])).values()].map((p) => ({
      avd: p.avd,
      systemImage: p.system_image,
      ...(p.device ? { device: p.device } : {}),
    }));
    android = {
      packages: [
        "platform-tools",
        ...(mobile.android.app.source === "build"
          ? [`platforms;android-${String(platform)}`, `build-tools;${buildTools}`]
          : []),
        ...(emulators.length > 0 ? ["emulator", ...new Set(emulators.map((e) => e.systemImage))] : []),
      ],
      emulators,
      atOnce: devices.length,
    };
  }
  if (mobile && mobile.appium.url === undefined) {
    if (mobile.android) {
      tools.set("appium", "mobile tests");
      tools.set("uiautomator2", "Android tests");
    }
    if (mobile.ios && !mobile.ios.farm) {
      tools.set("appium", "mobile tests");
      tools.set("xcuitest", "iOS tests on this Mac");
    }
  }
  if (mobile?.ios && !mobile.ios.farm) tools.set("xcode", "iOS tests on this Mac");
  return { tools, browsers, ...(android ? { android } : {}) };
}
