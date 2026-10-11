import { join } from "node:path";
import type { ToolchainFile } from "./config.js";
import { majorOf, type DetectedTool } from "./detect.js";
import {
  ANDROID_BASE,
  androidPackageBytes,
  CMDLINE_TOOLS,
  hostKey,
  JAVA_ARTIFACTS,
  JAVA_BASE,
  JAVA_RELEASE,
  MANIFEST,
  mirrored,
  TOOL_IDS,
  type Artifact,
  type Host,
  type ToolId,
} from "./manifest.js";
import type { ToolchainNeeds } from "./needs.js";
import type { InstalledTool } from "./registry.js";
import { satisfies } from "./semver.js";

/**
 * What setup does with a tool: use the user's own (`use-system`) or QAJitsu's copy (`use-managed`) as they are,
 * `install` or `reinstall` it, `start` the Docker daemon, or leave it: `skip` (not wanted), `manual` (the user has to
 * act; QAJitsu never changes a tool it did not install) and `unsupported` (cannot be done here).
 */
export type StepAction =
  "use-system" | "use-managed" | "install" | "reinstall" | "start" | "skip" | "manual" | "unsupported";

/** One line of the setup plan (REQ-GEN-06/AC4). */
export interface PlanStep {
  readonly tool: ToolId;
  readonly action: StepAction;
  readonly version: string;
  /** Approximate download size in bytes; 0 when nothing is downloaded. */
  readonly bytes: number;
  readonly source: string;
  readonly licence: string;
  readonly reason: string;
  /** Android packages or browsers to install; drivers' Appium home. */
  readonly parts: readonly string[];
  /** Where it is or will be. */
  readonly path?: string | undefined;
}

/** Choices of `qj setup` (REQ-GEN-06/AC4+AC5). */
export interface PlanOptions {
  readonly only?: readonly ToolId[];
  readonly skip?: readonly ToolId[];
  readonly reinstall?: readonly ToolId[];
  /** `--version tool=version`: install that version next to the current one. */
  readonly versions?: Readonly<Partial<Record<ToolId, string>>>;
}

/** Inputs of {@link planSetup}. */
export interface PlanInput {
  readonly needs: ToolchainNeeds;
  readonly detected: readonly DetectedTool[];
  readonly host: Host;
  readonly root: string;
  readonly config: ToolchainFile;
  readonly options: PlanOptions;
  /** Version of QAJitsu's Playwright: its browser builds are the ones installed. */
  readonly playwrightVersion?: string | undefined;
  /** The pinned archives (replaced in tests); the plan shows exactly what the installer downloads. */
  readonly artifacts?: { readonly java?: Artifact; readonly cmdlineTools?: Artifact } | undefined;
}

/** The managed Appium home holding the drivers when the user's Appium home lacks a compatible one. */
export const managedAppiumHome = (root: string): string => join(root, "appium-home", "3");

/** The managed Android SDK root and AVD folder. */
export const managedAndroid = (root: string): { sdk: string; avd: string } => ({
  sdk: join(root, "android", "sdk"),
  avd: join(root, "android", "avd"),
});

const fileVersion = (tool: ToolId, versions: ToolchainFile["versions"]): string | undefined =>
  tool === "java" || tool === "appium" || tool === "uiautomator2" || tool === "xcuitest" || tool === "xcode"
    ? versions[tool]
    : undefined;

/** The version a project asks for and the range its user-installed tool must be in. */
function wanted(
  tool: ToolId,
  input: PlanInput,
): { version: string; range: string; pinned: boolean; flag: boolean } {
  const flag = input.options.versions?.[tool];
  const pinned = flag ?? fileVersion(tool, input.config.versions);
  if (pinned === undefined)
    return { version: MANIFEST[tool].version, range: MANIFEST[tool].compatible, pinned: false, flag: false };
  return { version: pinned, range: pinned, pinned: true, flag: flag !== undefined };
}

const matches = (entry: InstalledTool, version: string): boolean =>
  entry.version === version || (!version.includes(".") && majorOf(entry.version) === Number(version));

function javaSource(version: string, input: PlanInput): { source: string; bytes: number } {
  if (version === JAVA_RELEASE) {
    const artifact = input.artifacts?.java ?? JAVA_ARTIFACTS[hostKey(input.host)];
    return {
      source: mirrored(artifact.url, JAVA_BASE, input.config.sources.java_mirror),
      bytes: artifact.size,
    };
  }
  return {
    source: `api.adoptium.net: the latest Eclipse Temurin ${version} release`,
    bytes: MANIFEST.java.bytes,
  };
}

const step = (
  tool: ToolId,
  action: StepAction,
  reason: string,
  extra: Partial<Omit<PlanStep, "tool" | "action" | "reason">> = {},
): PlanStep => ({
  tool,
  action,
  reason,
  version: extra.version ?? MANIFEST[tool].version,
  bytes: extra.bytes ?? 0,
  source: extra.source ?? MANIFEST[tool].source,
  licence: extra.licence ?? MANIFEST[tool].licence,
  parts: extra.parts ?? [],
  ...(extra.path !== undefined ? { path: extra.path } : {}),
});

function planManagedTool(tool: "java" | "appium", d: DetectedTool, input: PlanInput): PlanStep {
  const w = wanted(tool, input);
  const own = d.system;
  const existing = d.managed.find((m) => matches(m, w.version));
  const source =
    tool === "java"
      ? javaSource(w.version, input)
      : { source: `npm: appium@${w.version}`, bytes: MANIFEST.appium.bytes };
  if (input.options.reinstall?.includes(tool)) {
    const target = existing ?? d.managed[0];
    return target
      ? step(tool, "reinstall", "--reinstall", { version: target.version, path: target.path, ...source })
      : step(tool, "unsupported", `QAJitsu did not install ${tool}; there is nothing to reinstall`);
  }
  if (!w.flag && own?.compatible && own.version !== undefined && satisfies(own.version, w.range))
    return step(tool, "use-system", `yours (${own.where}) is compatible`, {
      version: own.version,
      path: own.where,
    });
  if (existing)
    return step(tool, "use-managed", "installed by QAJitsu", {
      version: existing.version,
      path: existing.path,
    });
  const why =
    own?.version !== undefined
      ? `yours (${own.version}, ${own.where}) is not ${w.pinned ? `the version the project pins (${w.range})` : `compatible (needs ${w.range})`}; QAJitsu installs one next to it and never changes yours`
      : w.flag
        ? `--version ${tool}=${w.version}`
        : "not found";
  return step(tool, "install", why, { version: w.version, ...source });
}

function planAndroid(d: DetectedTool, input: PlanInput): PlanStep {
  const own = d.system;
  const sdk = managedAndroid(input.root).sdk;
  const wantedParts = [
    ...(input.needs.android?.packages ?? ["platform-tools"]),
    ...(input.needs.android?.emulators ?? []).map((e) => `avd:${e.avd}`),
  ];
  const entry = d.managed[0];
  const pinned = input.artifacts?.cmdlineTools ?? CMDLINE_TOOLS[hostKey(input.host)];
  const cmdline = {
    ...pinned,
    url: mirrored(pinned.url, ANDROID_BASE, input.config.sources.android_mirror),
  };
  const bytesOf = (parts: readonly string[]): number =>
    parts.filter((p) => !p.startsWith("avd:")).reduce((sum, p) => sum + androidPackageBytes(p), 0);
  if (input.options.reinstall?.includes("android"))
    return entry
      ? step("android", "reinstall", "--reinstall", {
          version: entry.version,
          path: entry.path,
          parts: wantedParts,
          bytes: cmdline.size + bytesOf(wantedParts),
          source: cmdline.url,
        })
      : step(
          "android",
          "unsupported",
          "QAJitsu did not install the Android SDK; there is nothing to reinstall",
        );
  if (own?.compatible)
    return step("android", "use-system", `your SDK (${own.where}) has every package the project needs`, {
      version: "sdk",
      path: own.where,
    });
  const why =
    own !== undefined
      ? `your SDK (${own.where}) lacks ${own.missing.join(", ")}; QAJitsu installs its own SDK and never changes yours`
      : "not found";
  if (entry) {
    const missing = wantedParts.filter((p) => !entry.parts.includes(p));
    return missing.length === 0
      ? step("android", "use-managed", "installed by QAJitsu", {
          version: entry.version,
          path: entry.path,
          parts: entry.parts,
        })
      : step("android", "install", `QAJitsu's SDK lacks ${missing.join(", ")}`, {
          version: entry.version,
          path: entry.path,
          parts: missing,
          bytes: bytesOf(missing),
          source: "sdkmanager",
        });
  }
  return step("android", "install", why, {
    version: "sdk",
    path: sdk,
    parts: wantedParts,
    bytes: cmdline.size + bytesOf(wantedParts),
    source: cmdline.url,
  });
}

function planDrivers(
  detected: readonly DetectedTool[],
  input: PlanInput,
  selected: (tool: ToolId) => boolean,
): PlanStep[] {
  const drivers = (["uiautomator2", "xcuitest"] as const).filter(selected);
  const home = managedAppiumHome(input.root);
  const byTool = (t: ToolId): DetectedTool | undefined => detected.find((d) => d.tool === t);
  // The drivers share one Appium home: the user's when it has every compatible driver, else QAJitsu's.
  const userHomeOk = drivers.every((t) => {
    const own = byTool(t)?.system;
    const w = wanted(t, input);
    return !w.flag && own?.version !== undefined && own.compatible && satisfies(own.version, w.range);
  });
  return drivers.map((t) => {
    const d = byTool(t);
    const w = wanted(t, input);
    const existing = d?.managed.find((m) => m.version === w.version);
    if (input.options.reinstall?.includes(t)) {
      const target = existing ?? d?.managed[0];
      return target
        ? step(t, "reinstall", "--reinstall", { version: target.version, path: target.path, parts: [home] })
        : step(t, "unsupported", `QAJitsu did not install ${t}; there is nothing to reinstall`);
    }
    if (userHomeOk)
      return step(t, "use-system", `yours (${d?.system?.where ?? "~/.appium"}) is compatible`, {
        version: d?.system?.version ?? w.version,
        path: d?.system?.where,
      });
    if (existing)
      return step(t, "use-managed", "installed by QAJitsu", {
        version: existing.version,
        path: existing.path,
      });
    const own = d?.system;
    return step(
      t,
      "install",
      own?.version !== undefined
        ? `yours (${own.version}) is not ${w.pinned ? `the pinned ${w.range}` : `compatible (needs ${w.range})`}, or another driver is missing; installed into QAJitsu's Appium home`
        : "not found",
      {
        version: w.version,
        path: home,
        parts: [home],
        bytes: MANIFEST[t].bytes,
        source: `npm: appium-${t}-driver@${w.version}`,
      },
    );
  });
}

function planBrowsers(d: DetectedTool, input: PlanInput): PlanStep {
  if (input.options.versions?.browsers !== undefined)
    return step(
      "browsers",
      "unsupported",
      "browser versions are the builds of QAJitsu's Playwright; they cannot be chosen",
    );
  const wantedBrowsers =
    input.needs.browsers.length > 0 ? input.needs.browsers : ["chromium", "firefox", "webkit"];
  const reinstall = input.options.reinstall?.includes("browsers") === true;
  const missing = reinstall
    ? wantedBrowsers
    : (d.system?.missing ?? wantedBrowsers).filter((b) => wantedBrowsers.includes(b));
  if (d.system && missing.length === 0)
    return step("browsers", "use-system", "installed in Playwright's cache", {
      version: d.system.version ?? "",
    });
  return step("browsers", reinstall ? "reinstall" : "install", reinstall ? "--reinstall" : "not installed", {
    ...(input.playwrightVersion !== undefined
      ? { version: `Playwright ${input.playwrightVersion} builds` }
      : {}),
    parts: missing,
    bytes: Math.round((MANIFEST.browsers.bytes * missing.length) / 3),
  });
}

function planDocker(d: DetectedTool, input: PlanInput): PlanStep {
  if (input.options.versions?.docker !== undefined || input.options.reinstall?.includes("docker"))
    return step(
      "docker",
      "unsupported",
      "Docker is system-wide; QAJitsu installs it once and never changes it",
    );
  const own = d.system;
  if (own === undefined)
    return step("docker", "install", "not found", {
      bytes: MANIFEST.docker.bytes,
      source:
        input.host.os === "darwin"
          ? "Homebrew: colima docker docker-compose"
          : "apt: docker.io docker-compose-v2",
    });
  if (!own.compatible)
    return step(
      "docker",
      "manual",
      `yours (${own.version ?? "unknown"}) is not compatible (needs Docker ${MANIFEST.docker.compatible} with Compose v2); QAJitsu never changes it: update it yourself`,
      { version: own.version ?? "unknown" },
    );
  if (own.running !== true)
    return step("docker", "start", "installed but the daemon does not answer", {
      version: own.version ?? "",
      source: input.host.os === "darwin" ? "colima start" : "systemctl start docker",
    });
  return step("docker", "use-system", "yours is compatible and running", { version: own.version ?? "" });
}

function planXcode(d: DetectedTool, input: PlanInput): PlanStep {
  if (input.host.os !== "darwin")
    return step("xcode", "unsupported", "local iOS tests need a Mac; use mobile.ios.farm on this machine");
  if (input.options.reinstall?.includes("xcode"))
    return step(
      "xcode",
      "unsupported",
      "Xcode is system-wide; QAJitsu installs it once and never changes it",
    );
  const w = wanted("xcode", input);
  const own = d.system;
  if (!w.flag && own?.version !== undefined && satisfies(own.version, w.range))
    return step("xcode", "use-system", "yours is compatible", { version: own.version });
  return step(
    "xcode",
    "install",
    own?.version !== undefined
      ? `yours (${own.version}) is not ${w.pinned ? `the pinned ${w.range}` : `compatible (needs ${w.range})`}; xcodes installs one next to it`
      : "not found",
    { version: w.pinned ? w.version : MANIFEST.xcode.version, bytes: MANIFEST.xcode.bytes },
  );
}

/**
 * The setup plan (REQ-GEN-06/AC1, AC2, AC4, AC5): for every tool the project needs (or `--only` names), whether the
 * user's own compatible tool is used as it is, a copy QAJitsu installed is used, or what is installed, from where,
 * how big and under which licence. A user's tool that is not compatible is never changed: a compatible copy is
 * installed next to it, or, for the system-wide Docker, the user is told what to do. Pure: nothing is changed.
 */
export function planSetup(input: PlanInput): PlanStep[] {
  const { only, skip } = input.options;
  const selected = (tool: ToolId): boolean =>
    !(skip ?? []).includes(tool) &&
    (only !== undefined && only.length > 0 ? only.includes(tool) : input.needs.tools.has(tool));
  const byTool = (t: ToolId): DetectedTool =>
    input.detected.find((d) => d.tool === t) ?? { tool: t, needed: false, managed: [] };
  const drivers = planDrivers(input.detected, input, selected);
  return TOOL_IDS.map((tool): PlanStep => {
    if (!selected(tool))
      return step(
        tool,
        "skip",
        (skip ?? []).includes(tool)
          ? "--skip"
          : only !== undefined && only.length > 0
            ? "not in --only"
            : "not needed by this project",
      );
    const d = byTool(tool);
    switch (tool) {
      case "java":
      case "appium":
        return planManagedTool(tool, d, input);
      case "android":
        return planAndroid(d, input);
      case "uiautomator2":
      case "xcuitest":
        return drivers.find((s) => s.tool === tool) ?? step(tool, "skip", "not needed");
      case "browsers":
        return planBrowsers(d, input);
      case "docker":
        return planDocker(d, input);
      case "xcode":
        return planXcode(d, input);
    }
  });
}

/** Steps that download or change something. */
export const changingSteps = (steps: readonly PlanStep[]): PlanStep[] =>
  steps.filter((s) => s.action === "install" || s.action === "reinstall" || s.action === "start");
