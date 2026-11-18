import { describe, expect, it } from "vitest";
import type { Finding } from "./detect.js";
import { checkRecommendation, codeRecommendation, formatRecommendation } from "./rules.js";

const f = (id: string, kind: Finding["kind"], files: string[]): Finding => ({
  id,
  kind,
  files,
  detail: files.join(", "),
});
const web = [
  f("F1", "web-framework", ["package.json"]),
  f("F2", "openapi", ["api/openapi.yaml"]),
  f("F3", "compose", ["compose.yaml"]),
];
const mobile = [
  f("F1", "android-project", ["android/app/build.gradle"]),
  f("F2", "ios-project", ["ios/Shop.xcodeproj"]),
];

describe("the recommendation (REQ-GEN-13/AC2+AC3+AC5)", () => {
  it("REQ-GEN-13/AC5: from the findings alone: browsers for web, Docker for compose, the API description as a setting", () => {
    const r = codeRecommendation(web, { os: "linux" });
    expect(r.source).toBe("code");
    expect(r.install.map((a) => [a.tool, a.basis])).toEqual([
      ["browsers", ["F1"]],
      ["docker", ["F3"]],
    ]);
    expect(r.skip.map((s) => s.tool).sort()).toEqual([
      "android",
      "appium",
      "java",
      "uiautomator2",
      "xcode",
      "xcuitest",
    ]);
    expect(r.settings).toContainEqual(
      expect.objectContaining({ key: "openapi", value: "api/openapi.yaml", basis: ["F2"] }),
    );
    expect(r.settings.find((s) => s.key === "test_types")?.value).toBe("api, web");
  });

  it("REQ-GEN-13/AC5: Android everywhere; iOS with Xcode on macOS only, a device farm elsewhere", () => {
    const mac = codeRecommendation(mobile, { os: "darwin" });
    expect(mac.install.map((a) => a.tool)).toEqual([
      "java",
      "android",
      "uiautomator2",
      "xcode",
      "xcuitest",
      "appium",
    ]);
    const linux = codeRecommendation(mobile, { os: "linux" });
    expect(linux.install.map((a) => a.tool)).toEqual(["java", "android", "uiautomator2", "appium"]);
    expect(linux.skip.find((s) => s.tool === "xcode")?.why).toContain("device farm");
  });

  it("REQ-GEN-13/AC3: each tool with its download and disk size and the files it rests on; what is not installed; the command", () => {
    const text = formatRecommendation(codeRecommendation(web, { os: "linux" }), web);
    expect(text).toMatch(
      /browsers\s+340 MB download, 1\.1 GB on disk: web front-end or web tests found \(F1 package\.json\)/,
    );
    expect(text).toMatch(/docker\s+450 MB download, 3\.0 GB on disk/);
    expect(text).toContain("Together: 790 MB download, about 4.1 GB on disk.");
    expect(text).toMatch(/Not installed:\n(.|\n)*xcode\s+no iOS project found/);
    expect(text).toContain("openapi: api/openapi.yaml");
    expect(text).toContain("Command: qj setup --only browsers,docker");
    expect(text).toContain("Recommendation from the files found by code (no model asked):");
  });

  it("REQ-GEN-13/AC2: a model's recommendation keeps only what a finding of the right kind supports", () => {
    const baseline = codeRecommendation(web, { os: "linux" });
    const { recommendation, dropped } = checkRecommendation(
      {
        install: [
          { tool: "browsers", why: "React front-end", basis: ["F1"] },
          // Docker resting on a web finding, an unknown finding, nothing at all: no basis.
          { tool: "docker", why: "maybe", basis: ["F1", "F9"] },
          { tool: "java", why: "just in case", basis: [] },
        ],
        skip: [{ tool: "docker", why: "the team runs a shared staging" }],
        settings: [
          { key: "test_types", value: "api, web", why: "found", basis: ["F1", "F2"] },
          { key: "openapi", value: "docs/other.yaml", why: "guess", basis: ["F2"] },
        ],
      },
      web,
      baseline,
    );
    expect(recommendation.source).toBe("model");
    expect(recommendation.install.map((a) => a.tool)).toEqual(["browsers"]);
    expect(recommendation.skip.find((s) => s.tool === "docker")?.why).toBe("the team runs a shared staging");
    expect(recommendation.settings.map((s) => s.key)).toEqual(["test_types"]);
    expect(dropped).toEqual([
      "docker: no finding supports it",
      "java: no finding supports it",
      'setting openapi: no finding supports "docs/other.yaml"',
    ]);
  });
});
