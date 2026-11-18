import { MANIFEST, TOOL_IDS, type ToolId } from "@qajitsu/toolchain";
import { printable } from "../commands/cli-terminal.js";
import type { Finding, FindingKind } from "./detect.js";

/** A tool to install, why, and the findings it rests on. */
export interface ToolAdvice {
  readonly tool: ToolId;
  readonly why: string;
  /** Finding ids (`F1`). */
  readonly basis: readonly string[];
}

/** A `.qa/qa.project.yaml` setting the findings suggest (REQ-GEN-13/AC2). */
export interface SettingAdvice {
  readonly key: (typeof SETTING_KEYS)[number];
  readonly value: string;
  readonly why: string;
  readonly basis: readonly string[];
}

/** What to install and set, what not and why (REQ-GEN-13/AC2+AC3). */
export interface Recommendation {
  readonly install: readonly ToolAdvice[];
  readonly skip: readonly { readonly tool: ToolId; readonly why: string }[];
  readonly settings: readonly SettingAdvice[];
  /** Things found that QAJitsu does not test or install (gRPC, AsyncAPI, Maestro, Cypress). */
  readonly notes: readonly string[];
  /** `code`: the deterministic findings alone (offline, AC5); `model`: a model's recommendation checked by code. */
  readonly source: "code" | "model";
}

/** The settings a recommendation may propose: nothing else of the project's configuration (REQ-GEN-13/AC6). */
export const SETTING_KEYS = ["test_types", "openapi", "graphql", "wsdl"] as const;

const WEB: readonly FindingKind[] = ["web-framework", "web-pages", "playwright-tests", "cypress-tests"];
const ANDROID: readonly FindingKind[] = ["android-project", "react-native", "flutter", "appium-tests"];
const IOS: readonly FindingKind[] = ["ios-project", "react-native", "flutter", "appium-tests"];

/**
 * The findings each tool may rest on (REQ-GEN-13/AC2): a recommendation citing anything else has no basis and is
 * dropped. Only tools of QAJitsu's toolchain manifest can be recommended (AC6).
 */
export const TOOL_BASIS: Readonly<Record<ToolId, readonly FindingKind[]>> = {
  browsers: WEB,
  docker: ["compose"],
  java: ANDROID,
  android: ANDROID,
  appium: [...new Set([...ANDROID, ...IOS])],
  uiautomator2: ANDROID,
  xcuitest: IOS,
  xcode: IOS,
};

/** The finding kinds each setting may rest on, and which finding kind holds its file. */
const SETTING_BASIS: Readonly<Record<SettingAdvice["key"], readonly FindingKind[]>> = {
  test_types: [...WEB, ...ANDROID, ...IOS, "openapi", "graphql-sdl", "wsdl", "compose"],
  openapi: ["openapi"],
  graphql: ["graphql-sdl"],
  wsdl: ["wsdl"],
};

const hasAny = (findings: readonly Finding[], kinds: readonly FindingKind[]): Finding[] =>
  findings.filter((f) => kinds.includes(f.kind));
const ids = (fs: readonly Finding[]): string[] => fs.map((f) => f.id);

/**
 * The recommendation code makes from the findings alone (REQ-GEN-13/AC5): browsers for a web front-end or web
 * tests, Docker for compose files, Java, the Android SDK, Appium and UiAutomator2 for Android projects, Xcode and
 * XCUITest for iOS projects on macOS (elsewhere a device farm), the API descriptions as settings.
 *
 * @param findings - What {@link scanRepository} found.
 * @param host - The machine's OS: Xcode exists on macOS only.
 */
export function codeRecommendation(
  findings: readonly Finding[],
  host: { readonly os: string },
): Recommendation {
  const install: ToolAdvice[] = [];
  const skip: { tool: ToolId; why: string }[] = [];
  const web = hasAny(findings, WEB);
  const compose = hasAny(findings, ["compose"]);
  const android = hasAny(
    findings,
    ANDROID.filter((k) => k !== "appium-tests"),
  );
  const ios = hasAny(
    findings,
    IOS.filter((k) => k !== "appium-tests"),
  );
  const want = (tool: ToolId, basis: readonly Finding[], why: string, none: string): void => {
    if (basis.length > 0) install.push({ tool, why, basis: ids(basis) });
    else skip.push({ tool, why: none });
  };
  want("browsers", web, "web front-end or web tests found", "no web front-end or web tests found");
  want("docker", compose, "compose file found: --build starts the application", "no compose file found");
  want("java", android, "Android project found", "no Android project found");
  want("android", android, "Android project found", "no Android project found");
  want("uiautomator2", android, "Android project found: Appium's Android driver", "no Android project found");
  if (host.os === "darwin") {
    want("xcode", ios, "iOS project found", "no iOS project found");
    want("xcuitest", ios, "iOS project found: Appium's iOS driver", "no iOS project found");
  } else {
    const why =
      ios.length > 0
        ? "iOS project found, but Xcode needs macOS: run iOS cases on a device farm (mobile.ios.farm)"
        : "no iOS project found";
    skip.push({ tool: "xcode", why }, { tool: "xcuitest", why });
  }
  const mobile = install.some((a) => a.tool === "uiautomator2" || a.tool === "xcuitest");
  want(
    "appium",
    mobile ? [...android, ...(host.os === "darwin" ? ios : [])] : [],
    "mobile project found: QAJitsu drives devices through Appium",
    "no mobile project found",
  );

  const settings: SettingAdvice[] = [];
  const api = hasAny(findings, ["openapi", "graphql-sdl", "wsdl", "compose"]);
  const types = [
    ...(api.length > 0 || (web.length === 0 && android.length === 0 && ios.length === 0) ? ["api"] : []),
    ...(web.length > 0 ? ["web"] : []),
    ...(android.length > 0 || ios.length > 0 ? ["mobile"] : []),
  ];
  settings.push({
    key: "test_types",
    value: types.join(", "),
    why: "the kinds of tests the findings support",
    basis: ids([...api, ...web, ...android, ...ios]),
  });
  for (const [key, kind] of [
    ["openapi", "openapi"],
    ["graphql", "graphql-sdl"],
    ["wsdl", "wsdl"],
  ] as const) {
    const f = findings.find((x) => x.kind === kind);
    const file = f?.files[0];
    if (f && file)
      settings.push({ key, value: file, why: `responses are checked against ${file}`, basis: [f.id] });
  }

  const notes: string[] = [];
  for (const f of findings) {
    if (f.kind === "proto")
      notes.push(
        `gRPC (${f.files[0] ?? ".proto"}) found: QAJitsu has no gRPC runner yet, these services are not tested.`,
      );
    if (f.kind === "asyncapi")
      notes.push(`AsyncAPI (${f.files[0] ?? ""}) found: event-driven APIs are not tested yet.`);
    if (f.kind === "maestro-flows")
      notes.push("Maestro flows found: QAJitsu runs mobile cases through Appium; Maestro is not installed.");
    if (f.kind === "cypress-tests")
      notes.push("Cypress tests found: they stay as they are; QAJitsu's web cases run in Playwright.");
  }
  return { install, skip, settings, notes, source: "code" };
}

/**
 * Checks a model's recommendation against the findings by code (REQ-GEN-13/AC2+AC6): only tools of the toolchain
 * manifest and the allowed settings, every cited finding must exist and be a kind the tool or setting may rest on,
 * a setting's file must be one the findings name. A recommendation without a remaining basis is dropped and said so;
 * a tool neither recommended nor skipped is listed as not recommended.
 *
 * @param proposed - The model's answer, already shaped by its schema.
 * @param findings - The code's findings.
 * @param baseline - The code's recommendation: its notes are kept, and nothing it does not allow on this machine.
 * @returns The checked recommendation and what was dropped.
 */
export function checkRecommendation(
  proposed: {
    readonly install: readonly {
      readonly tool: string;
      readonly why: string;
      readonly basis: readonly string[];
    }[];
    readonly skip: readonly { readonly tool: string; readonly why: string }[];
    readonly settings: readonly {
      readonly key: string;
      readonly value: string;
      readonly why: string;
      readonly basis: readonly string[];
    }[];
  },
  findings: readonly Finding[],
  baseline: Recommendation,
): { readonly recommendation: Recommendation; readonly dropped: readonly string[] } {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const dropped: string[] = [];
  const allowedHere = new Set<string>(baseline.install.map((a) => a.tool));
  const install: ToolAdvice[] = [];
  for (const a of proposed.install) {
    if (!(TOOL_IDS as readonly string[]).includes(a.tool)) {
      dropped.push(`${a.tool.slice(0, 40)}: not a tool of QAJitsu's toolchain`);
      continue;
    }
    const tool = a.tool as ToolId;
    const basis = a.basis.filter((id) => {
      const f = byId.get(id);
      return f !== undefined && TOOL_BASIS[tool].includes(f.kind);
    });
    if (basis.length === 0) {
      dropped.push(`${tool}: no finding supports it`);
      continue;
    }
    if (!allowedHere.has(tool)) {
      dropped.push(`${tool}: not usable on this machine`);
      continue;
    }
    if (!install.some((x) => x.tool === tool)) install.push({ tool, why: a.why.slice(0, 300), basis });
  }
  const settings: SettingAdvice[] = [];
  for (const s of proposed.settings) {
    if (!(SETTING_KEYS as readonly string[]).includes(s.key)) {
      dropped.push(`setting ${s.key.slice(0, 40)}: not a setting a recommendation may change`);
      continue;
    }
    const key = s.key as SettingAdvice["key"];
    const basis = s.basis.filter((id) => {
      const f = byId.get(id);
      return f !== undefined && SETTING_BASIS[key].includes(f.kind);
    });
    const fileOk =
      key === "test_types"
        ? s.value
            .split(/[,\s]+/)
            .filter((t) => t !== "")
            .every((t) => ["api", "web", "mobile"].includes(t))
        : basis.some((id) => byId.get(id)?.files.includes(s.value) === true);
    if (basis.length === 0 || !fileOk) {
      dropped.push(`setting ${key}: no finding supports ${JSON.stringify(s.value.slice(0, 80))}`);
      continue;
    }
    settings.push({ key, value: s.value, why: s.why.slice(0, 300), basis });
  }
  const chosen = new Set(install.map((a) => a.tool));
  const skip: { tool: ToolId; why: string }[] = [];
  for (const tool of TOOL_IDS) {
    if (chosen.has(tool)) continue;
    const said = proposed.skip.find((x) => x.tool === tool);
    const code = baseline.skip.find((x) => x.tool === tool);
    skip.push({ tool, why: (said?.why ?? code?.why ?? "not recommended").slice(0, 300) });
  }
  return { recommendation: { install, skip, settings, notes: baseline.notes, source: "model" }, dropped };
}

/** Repository paths and model-written text as one printable line: no escape sequence, no forged line (M1). */
export const shown = (text: string): string => printable(text).replace(/\s+/g, " ").trim();

const size = (bytes: number): string =>
  bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(1)} GB` : `${String(Math.round(bytes / 1024 ** 2))} MB`;

/**
 * The recommendation as text (REQ-GEN-13/AC3): each tool with its download size, disk space and the findings with
 * their files; what will not be installed and why; the settings; and the command that installs the set.
 *
 * @param r - The recommendation.
 * @param findings - The findings it cites.
 */
export function formatRecommendation(r: Recommendation, findings: readonly Finding[]): string {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const cite = (basis: readonly string[]): string =>
    basis
      .map((id) => byId.get(id))
      .filter((f): f is Finding => f !== undefined)
      .map((f) => `${f.id} ${f.files.slice(0, 3).map(shown).join(", ")}${f.files.length > 3 ? ", …" : ""}`)
      .join("; ");
  const lines = [
    r.source === "code"
      ? "Recommendation from the files found by code (no model asked):"
      : "Recommendation (a model's proposal, every basis checked by code):",
  ];
  if (findings.length === 0) lines.push("  No application files found that decide how it is tested.");
  const install = r.install;
  const download = install.reduce((n, a) => n + MANIFEST[a.tool].bytes, 0);
  const disk = install.reduce((n, a) => n + MANIFEST[a.tool].diskBytes, 0);
  if (install.length > 0) {
    lines.push("Install:");
    for (const a of install)
      lines.push(
        `  ${a.tool.padEnd(13)} ${size(MANIFEST[a.tool].bytes)} download, ${size(MANIFEST[a.tool].diskBytes)} on disk: ${shown(a.why)} (${cite(a.basis)})`,
      );
    lines.push(`  Together: ${size(download)} download, about ${size(disk)} on disk.`);
  } else lines.push("Install: nothing.");
  lines.push("Not installed:");
  for (const s of r.skip) lines.push(`  ${s.tool.padEnd(13)} ${shown(s.why)}`);
  if (r.settings.length > 0) {
    lines.push("Settings for .qa/qa.project.yaml:");
    for (const s of r.settings)
      lines.push(`  ${s.key}: ${shown(s.value)}  (${shown(s.why)}; ${cite(s.basis)})`);
  }
  for (const n of r.notes) lines.push(`Note: ${shown(n)}`);
  if (install.length > 0) lines.push(`Command: qj setup --only ${install.map((a) => a.tool).join(",")}`);
  return `${lines.join("\n")}\n`;
}
