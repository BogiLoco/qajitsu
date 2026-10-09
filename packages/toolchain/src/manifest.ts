/**
 * Tools `qj setup` manages (REQ-GEN-06/AC1). `android` is the SDK with every package the project needs (platform
 * tools, command-line tools and, when configured, platform, build tools, emulator, system image and AVD).
 */
export const TOOL_IDS = [
  "browsers",
  "docker",
  "java",
  "android",
  "appium",
  "uiautomator2",
  "xcuitest",
  "xcode",
] as const;

/** One tool of {@link TOOL_IDS}. */
export type ToolId = (typeof TOOL_IDS)[number];

/** Whether a string names a tool `qj setup` manages. */
export function isToolId(value: string): value is ToolId {
  return (TOOL_IDS as readonly string[]).includes(value);
}

/** Operating system and processor the toolchain is installed for. */
export interface Host {
  readonly os: "darwin" | "linux";
  readonly arch: "arm64" | "x64";
}

/** A published checksum: SHA-256 where the publisher gives one, SHA-1 where it is the only one (Android). */
export interface Checksum {
  readonly algorithm: "sha256" | "sha1";
  readonly value: string;
}

/** A file to download, with its published size and checksum. */
export interface Artifact {
  readonly url: string;
  readonly size: number;
  readonly checksum: Checksum;
}

/**
 * Where a tool lives: `managed` under `~/.qajitsu/toolchain/` (one copy per version), `cache` in the tool's own
 * cache shared with other installations (Playwright browsers), `system` installed once for the machine and never
 * removed by QAJitsu (Docker, Xcode).
 */
export type ToolScope = "managed" | "cache" | "system";

/** What QAJitsu pins for one tool and which versions already on the machine it accepts. */
export interface ToolSpec {
  readonly id: ToolId;
  readonly title: string;
  /** The version `qj setup` installs; QAJitsu is tested with it. */
  readonly version: string;
  /** Versions already on the machine that are used as they are (REQ-GEN-06/AC2). */
  readonly compatible: string;
  readonly scope: ToolScope;
  readonly licence: string;
  /** Where it comes from, for the plan. */
  readonly source: string;
  /** Approximate download size in bytes, for the plan, the disk check and the confirmation. */
  readonly bytes: number;
}

const MB = 1024 * 1024;

/** Eclipse Temurin 17 release pinned by QAJitsu (REQ-GEN-06/AC1). */
export const JAVA_RELEASE = "17.0.20.1+1";

/** Base of the Temurin download URLs; a `java_mirror` replaces it. */
export const JAVA_BASE = "https://github.com/adoptium";

/** Temurin JDK archives with the checksums published by Adoptium (api.adoptium.net). */
export const JAVA_ARTIFACTS: Readonly<Record<`${Host["os"]}-${Host["arch"]}`, Artifact>> = {
  "darwin-arm64": {
    url: `${JAVA_BASE}/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_mac_hotspot_17.0.20.1_1.tar.gz`,
    size: 185_851_019,
    checksum: {
      algorithm: "sha256",
      value: "196d13ba5f10414bef7f6a05a9b3f00edacb18ebacef2b99485db9e2ee18f0e8",
    },
  },
  "darwin-x64": {
    url: `${JAVA_BASE}/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_mac_hotspot_17.0.20.1_1.tar.gz`,
    size: 180_578_248,
    checksum: {
      algorithm: "sha256",
      value: "c01975da12ed4235250ff891fe8bba73a9e73037d444b269c9d0922b5dbc8e0a",
    },
  },
  "linux-arm64": {
    url: `${JAVA_BASE}/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_aarch64_linux_hotspot_17.0.20.1_1.tar.gz`,
    size: 191_962_709,
    checksum: {
      algorithm: "sha256",
      value: "457b57af8f9c93ec39080bb8c764f559dc8c89a6da1a39d718a400b7890d3e41",
    },
  },
  "linux-x64": {
    url: `${JAVA_BASE}/temurin17-binaries/releases/download/jdk-17.0.20.1%2B1/OpenJDK17U-jdk_x64_linux_hotspot_17.0.20.1_1.tar.gz`,
    size: 193_252_603,
    checksum: {
      algorithm: "sha256",
      value: "3808d1d15e3ec6bd5b84057fb5d84c33d8a1536a258146bcea2e603fc726e08e",
    },
  },
};

/** Base of the Android repository; an `android_mirror` replaces it (also for `sdkmanager`). */
export const ANDROID_BASE = "https://dl.google.com/android/repository";

/** Android command-line tools 23.0 (build 16111833), checksums from Google's repository2-3.xml (SHA-1 only). */
export const CMDLINE_TOOLS: Readonly<Record<`${Host["os"]}-${Host["arch"]}`, Artifact>> = {
  "darwin-arm64": {
    url: `${ANDROID_BASE}/commandlinetools-mac_arm64-16111833_latest.zip`,
    size: 155_384_151,
    checksum: { algorithm: "sha1", value: "ad03dc49bfacfd52c110b14104ea548b8a07e830" },
  },
  "darwin-x64": {
    url: `${ANDROID_BASE}/commandlinetools-mac_x86_64-16111833_latest.zip`,
    size: 155_582_504,
    checksum: { algorithm: "sha1", value: "112cf9618794a997ff273537d55bee02c22abffe" },
  },
  "linux-arm64": {
    url: `${ANDROID_BASE}/commandlinetools-linux-16111833_latest.zip`,
    size: 181_052_239,
    checksum: { algorithm: "sha1", value: "e025545c62a8e64c7559119566a569fb1dec5f60" },
  },
  "linux-x64": {
    url: `${ANDROID_BASE}/commandlinetools-linux-16111833_latest.zip`,
    size: 181_052_239,
    checksum: { algorithm: "sha1", value: "e025545c62a8e64c7559119566a569fb1dec5f60" },
  },
};

/** Android platform and build tools installed when the app is built from the worktree (`app.source: build`). */
export const ANDROID_DEFAULTS = { platform: 34, buildTools: "34.0.0" } as const;

/** The manifest of pinned versions and compatible ranges (REQ-GEN-06/AC1+AC2). */
export const MANIFEST: Readonly<Record<ToolId, ToolSpec>> = {
  browsers: {
    id: "browsers",
    title: "Playwright browsers",
    version: "the builds of QAJitsu's Playwright",
    compatible: "*",
    scope: "cache",
    licence: "Chromium BSD-3-Clause, Firefox MPL-2.0, WebKit LGPL-2.1/BSD (Playwright builds)",
    source: "playwright.azureedge.net (or sources.playwright_host)",
    bytes: 340 * MB,
  },
  docker: {
    id: "docker",
    title: "Docker with Compose",
    version: "latest Colima + Docker CLI + Compose (macOS), Docker Engine (Linux)",
    compatible: ">=24",
    scope: "system",
    licence: "Colima MIT, Docker CLI and Engine Apache-2.0, Compose Apache-2.0",
    source: "Homebrew (macOS), the distribution's packages (Linux)",
    bytes: 450 * MB,
  },
  java: {
    id: "java",
    title: "Java (Eclipse Temurin JDK)",
    version: JAVA_RELEASE,
    compatible: ">=17",
    scope: "managed",
    licence: "GPL-2.0 with Classpath Exception (Eclipse Temurin)",
    source: "github.com/adoptium (or sources.java_mirror)",
    bytes: 190 * MB,
  },
  android: {
    id: "android",
    title: "Android SDK",
    version: "command-line tools 23.0 + the packages the project needs",
    compatible: "*",
    scope: "managed",
    licence: "Android Software Development Kit License Agreement (and the licences sdkmanager lists)",
    source: "dl.google.com/android/repository (or sources.android_mirror)",
    bytes: 170 * MB,
  },
  appium: {
    id: "appium",
    title: "Appium",
    version: "3.8.0",
    compatible: ">=3.0.0 <4.0.0",
    scope: "managed",
    licence: "Apache-2.0",
    source: "npm registry (or sources.npm_registry)",
    bytes: 60 * MB,
  },
  uiautomator2: {
    id: "uiautomator2",
    title: "Appium UiAutomator2 driver",
    version: "8.7.0",
    compatible: ">=8.0.0 <9.0.0",
    scope: "managed",
    licence: "Apache-2.0",
    source: "npm registry (or sources.npm_registry)",
    bytes: 40 * MB,
  },
  xcuitest: {
    id: "xcuitest",
    title: "Appium XCUITest driver",
    version: "12.16.0",
    compatible: ">=12.0.0 <13.0.0",
    scope: "managed",
    licence: "Apache-2.0",
    source: "npm registry (or sources.npm_registry)",
    bytes: 80 * MB,
  },
  xcode: {
    id: "xcode",
    title: "Xcode",
    version: "the latest release (xcodes)",
    compatible: ">=15",
    scope: "system",
    licence: "Xcode and Apple SDKs Agreement",
    source: "Apple Developer, through xcodes (needs an Apple ID)",
    bytes: 4096 * MB,
  },
};

/** Approximate sizes of Android SDK packages (from repository2-3.xml), for the plan and the disk check. */
export function androidPackageBytes(pkg: string): number {
  if (pkg === "platform-tools") return 16 * MB;
  if (pkg.startsWith("platforms;")) return 64 * MB;
  if (pkg.startsWith("build-tools;")) return 77 * MB;
  if (pkg === "emulator") return 495 * MB;
  if (pkg.startsWith("system-images;")) return 1600 * MB;
  return 50 * MB;
}

/** The key of the per-host artifact tables. */
export const hostKey = (host: Host): `${Host["os"]}-${Host["arch"]}` => `${host.os}-${host.arch}`;

/** Replaces the publisher's base URL with a mirror (REQ-GEN-06/AC7); checksums stay the publisher's. */
export function mirrored(url: string, base: string, mirror: string | undefined): string {
  return mirror !== undefined && url.startsWith(base)
    ? `${mirror.replace(/\/+$/, "")}${url.slice(base.length)}`
    : url;
}
