import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Resolves the Android SDK root: config, `$ANDROID_SDK_ROOT`, `$ANDROID_HOME`, then the macOS default. Shared by
 * `qj doctor`, `qj setup` and the mobile runner plugin.
 *
 * @param configured - `mobile.android.sdk_root` of the project, when set.
 */
export function androidSdkRoot(configured?: string): string {
  return (
    configured ??
    process.env["ANDROID_SDK_ROOT"] ??
    process.env["ANDROID_HOME"] ??
    join(homedir(), "Library", "Android", "sdk")
  );
}

const CHANNEL_DIRS: Readonly<Record<string, { mac: string; linux: string; win: string }>> = {
  chrome: {
    mac: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    linux: "/opt/google/chrome/chrome",
    win: "Google\\Chrome\\Application\\chrome.exe",
  },
  "chrome-beta": {
    mac: "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta",
    linux: "/opt/google/chrome-beta/chrome",
    win: "Google\\Chrome Beta\\Application\\chrome.exe",
  },
  msedge: {
    mac: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    linux: "/opt/microsoft/msedge/msedge",
    win: "Microsoft\\Edge\\Application\\msedge.exe",
  },
  "msedge-beta": {
    mac: "/Applications/Microsoft Edge Beta.app/Contents/MacOS/Microsoft Edge Beta",
    linux: "/opt/microsoft/msedge-beta/msedge",
    win: "Microsoft\\Edge Beta\\Application\\msedge.exe",
  },
};

/**
 * Where Playwright looks for an installed branded browser (REQ-EXEC-66/AC2): the vendor's standard install paths.
 *
 * @param channel - `chrome`, `chrome-beta`, `msedge` or `msedge-beta`.
 * @param os - Platform, `process.platform` by default.
 * @param env - Environment with `LOCALAPPDATA` and `PROGRAMFILES` on Windows.
 */
export function channelExecutables(
  channel: string,
  os: NodeJS.Platform = process.platform,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string[] {
  const dirs = CHANNEL_DIRS[channel];
  if (!dirs) return [];
  if (os === "darwin") return [dirs.mac];
  if (os === "linux") return [dirs.linux];
  if (os === "win32")
    return [env["LOCALAPPDATA"], env["PROGRAMFILES"], env["PROGRAMFILES(X86)"]]
      .filter((d): d is string => d !== undefined && d !== "")
      .map((d) => `${d}\\${dirs.win}`);
  return [];
}
