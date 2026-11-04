import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publishRefusal } from "./publish-guard.mjs";

const RELEASE = {
  GITHUB_ACTIONS: "true",
  GITHUB_WORKFLOW: "Release",
  GITHUB_REPOSITORY: "BogiLoco/qajitsu",
  GITHUB_REF: "refs/heads/main",
};

describe("publishing only from the Release workflow (REQ-GEN-15/AC2)", () => {
  it("REQ-GEN-15/AC2: the Release workflow on main of this repository may publish", () => {
    expect(publishRefusal(RELEASE)).toBeUndefined();
  });

  it("REQ-GEN-15/AC2: a laptop, another workflow, a fork or another branch is refused with the reason", () => {
    expect(publishRefusal({})).toBe("packages are published by CI only: merge the version pull request");
    expect(publishRefusal({ ...RELEASE, GITHUB_WORKFLOW: "CI" })).toBe(
      "the CI workflow does not publish; Release does",
    );
    expect(publishRefusal({ ...RELEASE, GITHUB_REPOSITORY: "someone/qajitsu" })).toBe(
      "someone/qajitsu is not BogiLoco/qajitsu",
    );
    expect(publishRefusal({ ...RELEASE, GITHUB_REF: "refs/heads/feat/x" })).toBe(
      "releases come from main, not refs/heads/feat/x",
    );
    expect(publishRefusal({ ...RELEASE, GITHUB_ACTIONS: "false" })).toBeDefined();
  });

  it("REQ-GEN-15/AC2: run as a script it fails outside the Release workflow", () => {
    const script = fileURLToPath(new URL("./publish-guard.mjs", import.meta.url));
    const local = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH },
      encoding: "utf8",
    });
    expect(local.status).toBe(1);
    expect(local.stderr).toContain("Publishing refused: packages are published by CI only");
    const ci = spawnSync(process.execPath, [script], {
      env: { PATH: process.env.PATH, ...RELEASE },
      encoding: "utf8",
    });
    expect(ci.status).toBe(0);
  });
});
