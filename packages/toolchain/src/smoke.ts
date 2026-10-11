import { join } from "node:path";
import { appiumBinOf, androidEnv, type InstallContext } from "./installers.js";
import type { ToolId } from "./manifest.js";
import type { AndroidNeeds } from "./needs.js";
import { managedAndroid } from "./plan.js";
import type { InstalledTool } from "./registry.js";

/** Outcome of the smoke test of one tool (REQ-GEN-06/AC8). */
export interface SmokeResult {
  readonly tool: ToolId;
  readonly ok: boolean;
  readonly detail: string;
  /** What to do when it failed. */
  readonly next?: string | undefined;
}

/** Ports the smoke tests use besides commands. */
export interface SmokePorts {
  /** Starts a browser headless and closes it; resolves to an error message, or undefined when it worked. */
  readonly launchBrowser?: (name: string) => Promise<string | undefined>;
  /** Boots the emulator once and stops it (`--smoke`); resolves to an error message, or undefined. */
  readonly bootEmulator?: (
    sdk: string,
    avd: string,
    systemImage: string,
    env: Readonly<Record<string, string>>,
  ) => Promise<string | undefined>;
}

const ok = (tool: ToolId, detail: string): SmokeResult => ({ tool, ok: true, detail });
const failed = (tool: ToolId, detail: string, next: string): SmokeResult => ({
  tool,
  ok: false,
  detail,
  next,
});

async function run(
  ctx: InstallContext,
  cmd: string,
  args: readonly string[],
  env: Record<string, string> = {},
) {
  return ctx.exec(cmd, args, { env: { ...ctx.network.env, ...env } }).catch((error: unknown) => ({
    code: 127,
    stdout: "",
    stderr: error instanceof Error ? error.message : String(error),
  }));
}

async function smokeAndroid(
  ctx: InstallContext,
  entry: InstalledTool,
  android: AndroidNeeds | undefined,
  ports: SmokePorts,
  boot: boolean,
  noAccel: boolean,
): Promise<SmokeResult> {
  const sdk = entry.path;
  const env = androidEnv(ctx, sdk, managedAndroid(ctx.root).avd);
  const listed = await run(
    ctx,
    join(sdk, "cmdline-tools", "latest", "bin", "sdkmanager"),
    [`--sdk_root=${sdk}`, "--list_installed"],
    env,
  );
  const packages = entry.parts.filter((p) => !p.startsWith("avd:"));
  const missing = packages.filter((p) => !listed.stdout.includes(p));
  if (listed.code !== 0 || missing.length > 0)
    return failed(
      "android",
      listed.code !== 0
        ? `sdkmanager does not run: ${listed.stderr.trim().slice(-200)}`
        : `sdkmanager does not list ${missing.join(", ")}`,
      "qj setup --reinstall android",
    );
  if (android?.emulator && noAccel)
    return ok(
      "android",
      `sdkmanager lists ${String(packages.length)} packages; acceleration not checked (--ignore-check virtualisation)`,
    );
  if (android?.emulator) {
    const accel = await run(ctx, join(sdk, "emulator", "emulator"), ["-accel-check"], env);
    // The emulator prints "accel:", the status (0 means usable) and a description.
    if (!/accel:\s*\n\s*0\b/.test(accel.stdout))
      return failed(
        "android",
        `the emulator's acceleration check failed: ${(accel.stdout + accel.stderr).trim().slice(-200)}`,
        "enable hardware virtualisation (HVF/KVM) or run Android tests on a device farm (mobile.appium.url)",
      );
    if (boot && ports.bootEmulator) {
      const error = await ports.bootEmulator(sdk, android.emulator.avd, android.emulator.systemImage, env);
      if (error !== undefined)
        return failed(
          "android",
          `the emulator did not boot: ${error}`,
          `qj setup --reinstall android --smoke`,
        );
      return ok("android", `sdkmanager lists ${String(packages.length)} packages; the emulator booted`);
    }
  }
  return ok(
    "android",
    `sdkmanager lists ${String(packages.length)} packages${android?.emulator ? "; acceleration check passed" : ""}`,
  );
}

/**
 * Proves an installed tool works (REQ-GEN-06/AC8): Java runs and reports its version, sdkmanager lists the installed
 * packages and the emulator's acceleration check passes (with `--smoke` the emulator boots once), Appium reports its
 * version and lists its drivers, each browser starts, Docker and Compose answer, Xcode reports its version. A tool that
 * did not pass is never reported ready; the result names the next step.
 */
export async function smokeTest(
  ctx: InstallContext,
  entry: InstalledTool,
  options: {
    readonly android?: AndroidNeeds | undefined;
    readonly boot: boolean;
    readonly ports: SmokePorts;
    /** The virtualisation precheck was ignored on purpose (an image built without KVM): no acceleration check. */
    readonly noAccel?: boolean;
  },
): Promise<SmokeResult> {
  switch (entry.tool) {
    case "java": {
      const out = await run(ctx, join(entry.path, "bin", "java"), ["-version"]);
      const version = /version "([^"]+)"/.exec(out.stdout + out.stderr)?.[1];
      return version !== undefined
        ? ok("java", `java ${version} runs`)
        : failed("java", `java does not run: ${out.stderr.trim().slice(-200)}`, "qj setup --reinstall java");
    }
    case "android":
      return smokeAndroid(ctx, entry, options.android, options.ports, options.boot, options.noAccel === true);
    case "appium": {
      const out = await run(ctx, appiumBinOf(entry.path), ["--version"]);
      return out.stdout.trim().startsWith(entry.version)
        ? ok("appium", `appium ${entry.version} runs`)
        : failed(
            "appium",
            `appium does not report ${entry.version}: ${(out.stdout + out.stderr).trim().slice(-200)}`,
            "qj setup --reinstall appium",
          );
    }
    case "uiautomator2":
    case "xcuitest": {
      const bin = ctx.appiumBin ?? "appium";
      const out = await run(ctx, bin, ["driver", "list", "--installed", "--json"], {
        APPIUM_HOME: entry.path,
      });
      let drivers: Record<string, { version?: string }> = {};
      try {
        drivers = JSON.parse(/(\{[\s\S]*\})/.exec(out.stdout)?.[1] ?? "{}") as typeof drivers;
      } catch {
        drivers = {};
      }
      return drivers[entry.tool]?.version === entry.version
        ? ok(entry.tool, `appium lists ${entry.tool} ${entry.version}`)
        : failed(
            entry.tool,
            `appium does not list ${entry.tool} ${entry.version}`,
            `qj setup --reinstall ${entry.tool}`,
          );
    }
    case "browsers": {
      const errors: string[] = [];
      for (const name of entry.parts) {
        const error = options.ports.launchBrowser
          ? await options.ports.launchBrowser(name)
          : "cannot be started here";
        if (error !== undefined) errors.push(`${name}: ${error.slice(0, 200)}`);
      }
      return errors.length === 0
        ? ok("browsers", `${entry.parts.join(", ")} start`)
        : failed(
            "browsers",
            errors.join("; "),
            ctx.host.os === "linux"
              ? "install the browsers' system libraries: sudo npx playwright-core install-deps"
              : "qj setup --reinstall browsers",
          );
    }
    case "docker": {
      const info = await run(ctx, "docker", ["info", "--format", "{{.ServerVersion}}"]);
      const compose = await run(ctx, "docker", ["compose", "version", "--short"]);
      return info.code === 0 && compose.code === 0
        ? ok("docker", `Docker ${info.stdout.trim()} and Compose ${compose.stdout.trim()} answer`)
        : failed(
            "docker",
            info.code !== 0 ? "the Docker daemon does not answer" : "docker compose does not run",
            ctx.host.os === "darwin"
              ? "colima start, then qj doctor"
              : "sudo systemctl start docker; add yourself to the docker group",
          );
    }
    case "xcode": {
      const out = await run(ctx, "xcodebuild", ["-version"]);
      return out.code === 0
        ? ok("xcode", out.stdout.split("\n")[0] ?? "xcodebuild runs")
        : failed(
            "xcode",
            "xcodebuild does not run",
            "sudo xcode-select -s /Applications/Xcode.app; xcodebuild -runFirstLaunch",
          );
    }
  }
}
