import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { EXPECTED } from "./provenance-check.mjs";
import { PUBLISHER, npmError, readTrust, trustAll, trustArgs } from "./trusted-publishing.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const ours = {
  id: "t1",
  type: "github",
  claims: {
    repository: "BogiLoco/qajitsu",
    workflow_ref: { file: "release.yml" },
    environment: "npm-publish",
  },
};
const other = { ...ours, claims: { ...ours.claims, repository: "someone/fork" } };

/** A fake npm: `trust list` answers from `state`, `trust github` adds the Release workflow unless `refuse`. */
function fakeNpm(state, { refuse = false, failList = false } = {}) {
  const calls = [];
  const npm = (args, interactive) => {
    calls.push({ args, interactive });
    const name = args[2];
    if (args[1] === "list")
      return failList
        ? {
            status: 1,
            stdout: "",
            stderr:
              "npm error code E401\nnpm error 401 Unauthorized\nnpm error A complete log of this run can be found in: x.log\n",
          }
        : { status: 0, stdout: JSON.stringify(state[name] ?? []), stderr: "" };
    if (!refuse) state[name] = [...(state[name] ?? []), ours];
    return { status: refuse ? 1 : 0, stdout: "", stderr: "" };
  };
  return { npm, calls };
}

describe("npm trusted publishing of every package (REQ-GEN-15/AC6)", () => {
  it("REQ-GEN-15/AC6: the trusted publisher is this repository's Release workflow in its npm-publish environment", () => {
    const release = parse(readFileSync(join(root, ".github", "workflows", PUBLISHER.file), "utf8"));
    expect(release.jobs.release.environment).toBe(PUBLISHER.environment);
    expect(`https://github.com/${PUBLISHER.repository}`).toBe(EXPECTED.repository);
    expect(EXPECTED.path).toBe(`.github/workflows/${PUBLISHER.file}`);
    expect(trustArgs("@qajitsu/core")).toEqual([
      "trust",
      "github",
      "@qajitsu/core",
      "--file",
      "release.yml",
      "--repository",
      "BogiLoco/qajitsu",
      "--environment",
      "npm-publish",
      "--allow-publish",
      "--yes",
    ]);
  });

  it("REQ-GEN-15/AC6: the Release workflow is told from any other trusted publisher", () => {
    expect(readTrust("")).toEqual({ ours: 0, others: 0 });
    expect(readTrust("[]")).toEqual({ ours: 0, others: 0 });
    expect(readTrust(JSON.stringify([ours]))).toEqual({ ours: 1, others: 0 });
    expect(readTrust(JSON.stringify({ trustedPublishers: [ours, other] }))).toEqual({ ours: 1, others: 1 });
    expect(readTrust(JSON.stringify(ours))).toEqual({ ours: 1, others: 0 });
    const byPath = {
      repository: "bogiloco/qajitsu",
      workflow: ".github/workflows/release.yml",
      env: "npm-publish",
    };
    expect(readTrust(JSON.stringify([byPath]))).toEqual({ ours: 1, others: 0 });
    for (const changed of [
      { ...byPath, workflow: ".github/workflows/ci.yml" },
      { ...byPath, env: "production" },
      { ...byPath, repository: "BogiLoco/qajitsu-fork" },
    ])
      expect(readTrust(JSON.stringify([changed]))).toEqual({ ours: 0, others: 1 });
  });

  it("REQ-GEN-15/AC6: a package without it gets it, interactively so npm can ask for a one-time password", () => {
    const state = { "@qajitsu/core": [ours] };
    const { npm, calls } = fakeNpm(state);
    expect(trustAll(["@qajitsu/core", "@qajitsu/cli"], npm, false)).toEqual([]);
    expect(calls.filter((c) => c.args[1] === "github")).toEqual([
      { args: trustArgs("@qajitsu/cli"), interactive: true },
    ]);
    expect(calls.filter((c) => c.args[1] === "list").every((c) => !c.interactive)).toBe(true);
  });

  it("REQ-GEN-15/AC6: --check changes nothing and names every package that is not set", () => {
    const { npm, calls } = fakeNpm({ "@qajitsu/core": [ours], "@qajitsu/guard": [ours, other] });
    expect(trustAll(["@qajitsu/core", "@qajitsu/cli", "@qajitsu/guard"], npm, true)).toEqual([
      "@qajitsu/cli: the Release workflow is not its trusted publisher",
      "@qajitsu/guard: 1 other trusted publisher(s); revoke them on npmjs.com",
    ]);
    expect(calls.some((c) => c.args[1] === "github")).toBe(false);
  });

  it("REQ-GEN-15/AC6: a refused change, another publisher or an unanswered list is a problem, never success", () => {
    expect(trustAll(["@qajitsu/cli"], fakeNpm({}, { refuse: true }).npm, false)).toEqual([
      "@qajitsu/cli: the Release workflow is not its trusted publisher",
    ]);
    // A package that already trusts someone else is not given a second publisher silently.
    const withOther = fakeNpm({ "@qajitsu/cli": [other] });
    expect(trustAll(["@qajitsu/cli"], withOther.npm, false)).toEqual([
      "@qajitsu/cli: the Release workflow is not its trusted publisher",
    ]);
    expect(withOther.calls.some((c) => c.args[1] === "github")).toBe(false);
    expect(trustAll(["@qajitsu/cli"], fakeNpm({}, { failList: true }).npm, true)).toEqual([
      "@qajitsu/cli: npm trust list failed: npm error 401 Unauthorized",
    ]);
  });

  it("REQ-GEN-15/AC6: the reason npm gives is shown, not where its log is", () => {
    expect(
      npmError(
        "npm warn x\nnpm error code E403\nnpm error 403 Forbidden\nnpm error A complete log of this run\n",
      ),
    ).toBe("npm error 403 Forbidden");
    expect(npmError("something else\n")).toBe("something else");
    expect(npmError("")).toBe("no output");
  });
});
