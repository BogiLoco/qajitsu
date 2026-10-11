import { dirname, join } from "node:path";
import { appiumBinOf } from "./installers.js";
import { ANALYTICS_OFF } from "./network.js";
import type { ToolchainChoice } from "./registry.js";

/** Variables for the processes QAJitsu starts, and folders to put first on their PATH. */
export interface ToolchainEnv {
  readonly vars: Readonly<Record<string, string>>;
  readonly path: readonly string[];
}

/**
 * The environment of the processes QAJitsu starts (REQ-GEN-06/AC3+AC9): for every tool the project uses from
 * QAJitsu's toolchain, `JAVA_HOME`, `ANDROID_HOME`/`ANDROID_SDK_ROOT`, `ANDROID_AVD_HOME`, `APPIUM_HOME` and their
 * folders on PATH; tools' usage analytics off. A tool the project uses from the user's own installation is left as
 * the user set it. Shell profiles are never edited: this applies to QAJitsu's process and its children only.
 *
 * @param choice - The project's toolchain choice written by `qj setup`; undefined leaves everything as it is.
 * @param exists - Checks a managed folder still exists (a removed one is not used).
 */
export function toolchainEnv(
  choice: ToolchainChoice | undefined,
  exists: (path: string) => boolean,
): ToolchainEnv {
  const vars: Record<string, string> = { ...ANALYTICS_OFF };
  const path: string[] = [];
  const managed = (tool: keyof ToolchainChoice["tools"]): string | undefined => {
    const c = choice?.tools[tool];
    return c?.use === "managed" && c.path !== undefined && exists(c.path) ? c.path : undefined;
  };
  const java = managed("java");
  if (java !== undefined) {
    vars["JAVA_HOME"] = java;
    path.push(join(java, "bin"));
  }
  const sdk = managed("android");
  if (sdk !== undefined) {
    vars["ANDROID_HOME"] = sdk;
    vars["ANDROID_SDK_ROOT"] = sdk;
    vars["ANDROID_AVD_HOME"] = join(dirname(sdk), "avd");
    path.push(
      join(sdk, "platform-tools"),
      join(sdk, "emulator"),
      join(sdk, "cmdline-tools", "latest", "bin"),
    );
  }
  const appium = managed("appium");
  if (appium !== undefined) path.push(dirname(appiumBinOf(appium)));
  const drivers = managed("uiautomator2") ?? managed("xcuitest");
  if (drivers !== undefined) vars["APPIUM_HOME"] = drivers;
  return { vars, path };
}

/** Applies a {@link ToolchainEnv} to an environment object, managed folders first on PATH. */
export function applyToolchainEnv(env: Record<string, string | undefined>, te: ToolchainEnv): void {
  for (const [key, value] of Object.entries(te.vars)) env[key] = value;
  if (te.path.length > 0)
    env["PATH"] = [
      ...te.path,
      ...(env["PATH"] ?? "").split(":").filter((p) => p !== "" && !te.path.includes(p)),
    ].join(":");
}
