import { describe, expect, it } from "vitest";
import { compareVersions, parseVersion, satisfies } from "./semver.js";

describe("tool versions (REQ-GEN-06/AC2)", () => {
  it.each([
    ["17.0.20.1+1", [17, 0, 20, 1]],
    ["1.8.0_392", [8, 0, 392]],
    ["21", [21]],
    ["v3.8.0", [3, 8, 0]],
    ["28.1.1-rd", [28, 1, 1]],
    ["android-34", [34]],
    ["Xcode 16.4", [16, 4]],
  ])("reads %s as %j", (text, parts) => {
    expect(parseVersion(text)).toEqual(parts);
  });

  it("does not guess a version from text without one", () => {
    expect(parseVersion("unknown")).toBeUndefined();
    expect(satisfies("unknown", ">=17")).toBe(false);
  });

  it("compares numerically, missing parts count as 0", () => {
    expect(compareVersions("17.0.9", "17.0.10")).toBeLessThan(0);
    expect(compareVersions("21", "21.0.0")).toBe(0);
    expect(compareVersions("3.10.0", "3.8.0")).toBeGreaterThan(0);
  });

  it.each([
    ["17.0.20", ">=17", true],
    ["11.0.2", ">=17", false],
    ["1.8.0_392", ">=17", false],
    ["3.8.0", ">=3.0.0 <4.0.0", true],
    ["4.0.0", ">=3.0.0 <4.0.0", false],
    ["8.9.1", "^8.7.0", true],
    ["8.6.0", "^8.7.0", false],
    ["9.0.0", "^8.7.0", false],
    ["0.4.2", "^0.4.0", true],
    ["0.5.0", "^0.4.0", false],
    ["21.0.4", "21", true],
    ["22.0.1", "21", false],
    ["16.4", ">16 <=16.4", true],
    ["16.0", ">16", false],
    ["3.8.0", "=3.8.0", true],
    ["3.8.0", "3.8.0", true],
    ["3.8.1", "3.8.0", false],
    ["24.0.0", "*", true],
  ])("%s satisfies %s: %s", (version, range, expected) => {
    expect(satisfies(version, range)).toBe(expected);
  });

  it("rejects a range it cannot read instead of accepting every version", () => {
    expect(satisfies("17", "~>17")).toBe(false);
    expect(satisfies("17", "")).toBe(false);
  });
});
