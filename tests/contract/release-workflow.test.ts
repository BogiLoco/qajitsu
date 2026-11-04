// The release pipeline of the repository (REQ-GEN-15): what it runs, in which order, with which rights.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = fileURLToPath(new URL("../../", import.meta.url));

interface Step {
  readonly id?: string;
  readonly name?: string;
  readonly if?: string;
  readonly uses?: string;
  readonly run?: string;
  readonly with?: Record<string, unknown>;
  readonly env?: Record<string, unknown>;
}
interface Job {
  readonly if?: string;
  readonly needs?: string;
  readonly environment?: string;
  readonly permissions?: Record<string, string>;
  readonly steps: readonly Step[];
}
interface Workflow {
  readonly on: Record<string, unknown>;
  readonly permissions?: Record<string, string>;
  readonly concurrency?: { readonly group?: string; readonly "cancel-in-progress"?: boolean };
  readonly jobs: Record<string, Job>;
}

const workflow = (name: string): Workflow =>
  parse(readFileSync(join(root, ".github", "workflows", name), "utf8")) as Workflow;
const scripts = (
  JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts: Record<string, string> }
).scripts;
const index = (steps: readonly Step[], match: (s: Step) => boolean): number => steps.findIndex(match);
const secretsIn = (value: unknown): boolean => JSON.stringify(value ?? {}).includes("secrets.");

describe("the release workflow (REQ-GEN-15/AC1+AC2)", () => {
  const release = workflow("release.yml");
  const test = release.jobs["test"];
  const publishJob = release.jobs["release"];
  const steps = publishJob?.steps ?? [];
  const changesets = steps.find((s) => s.uses?.startsWith("changesets/action@"));
  const publish = steps.find((s) => s.run === "pnpm release");
  const githubRelease = steps.find((s) => s.run === "node scripts/github-release.mjs");

  it("REQ-GEN-15/AC2: it runs on main only, one at a time, never for a pull request or a fork", () => {
    expect(Object.keys(release.on)).toEqual(["push"]);
    expect(release.on["push"]).toEqual({ branches: ["main"] });
    expect(release.concurrency).toEqual({ group: "release", "cancel-in-progress": false });
    expect(test?.if).toBe("github.repository == 'BogiLoco/qajitsu'");
    expect(publishJob?.needs).toBe("test");
  });

  it("REQ-GEN-15/AC2: everything that runs dependency code does so without write rights or secrets", () => {
    expect(release.permissions).toEqual({ contents: "read" });
    expect(test?.permissions).toEqual({ contents: "read" });
    expect(test?.environment).toBeUndefined();
    for (const step of test?.steps ?? []) expect(secretsIn(step), JSON.stringify(step)).toBe(false);
    const checkout = test?.steps.find((s) => s.uses?.startsWith("actions/checkout@"));
    expect(checkout?.with?.["persist-credentials"]).toBe(false);
    const node = test?.steps.find((s) => s.uses?.startsWith("actions/setup-node@"));
    expect(node?.with?.["cache"]).toBeUndefined();
    const run = (test?.steps ?? []).map((s) => s.name ?? s.run ?? s.uses ?? "");
    const at = [
      "pnpm install --frozen-lockfile",
      "pnpm verify",
      "pnpm build",
      "plugins as installed",
      "node scripts/release-check.mjs",
    ].map((r) => run.indexOf(r));
    expect(
      at.every((i) => i >= 0),
      run.join(" | "),
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
    expect(test?.steps.find((s) => s.name === "plugins as installed")?.env).toEqual({
      QAJITSU_E2E_NETWORK: "1",
    });
  });

  it("REQ-GEN-15/AC2: the release job holds the rights and the token, each step only what it needs", () => {
    expect(publishJob?.environment).toBe("npm-publish");
    expect(publishJob?.permissions).toEqual({
      contents: "write",
      "pull-requests": "write",
      "id-token": "write",
    });
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
    // The npm token reaches the publish step only, never the version step or the install.
    for (const step of steps) {
      const npmToken = JSON.stringify(step.env ?? {}).includes("NPM_TOKEN");
      expect(npmToken, JSON.stringify(step)).toBe(step === publish);
    }
    expect(publish?.env).toEqual({
      NODE_AUTH_TOKEN: "${{ secrets.NPM_TOKEN }}",
      NPM_CONFIG_PROVENANCE: "true",
    });
    expect(publish?.if).toBe("steps.changesets.outputs.hasChangesets == 'false'");
    expect(githubRelease?.if).toBe("steps.changesets.outputs.hasChangesets == 'false'");
    expect(githubRelease?.env).toEqual({ GH_TOKEN: "${{ github.token }}" });
    expect(index(steps, (s) => s === githubRelease)).toBeGreaterThan(index(steps, (s) => s === publish));
  });

  it("REQ-GEN-15/AC2: every action is pinned to a commit", () => {
    for (const job of Object.values(release.jobs))
      for (const step of job.steps)
        if (step.uses !== undefined) expect(step.uses, step.uses).toMatch(/^[\w-]+\/[\w-]+@[0-9a-f]{40}$/);
  });

  it("REQ-GEN-15/AC1: the version pull request is made by code: versions, changelogs, plugin catalogue, lockfile", () => {
    expect(changesets?.id).toBe("changesets");
    // The action publishes nothing itself: publishing is its own step, with its own token.
    expect(changesets?.with).toEqual({
      version: "pnpm version-packages",
      title: "chore(release): version packages",
      commit: "chore(release): version packages",
    });
    const version = scripts["version-packages"] ?? "";
    const order = [
      "changeset version",
      "scripts/plugin-catalogue.mjs",
      "pnpm install --lockfile-only",
      "prettier --write",
    ];
    const at = order.map((part) => version.indexOf(part));
    expect(
      at.every((i) => i >= 0),
      version,
    ).toBe(true);
    expect([...at].sort((a, b) => a - b)).toEqual(at);
  });

  it("REQ-GEN-15/AC1: all packages version together, so every later release is one version too", () => {
    const config = JSON.parse(readFileSync(join(root, ".changeset", "config.json"), "utf8")) as {
      fixed?: unknown;
    };
    expect(config.fixed).toEqual([["@qajitsu/*"]]);
  });

  it("REQ-GEN-15/AC2+AC3: publishing is guarded, from a clean build, after an inspection, by pnpm, then tagged", () => {
    const parts = (scripts["release"] ?? "").split("&&").map((s) => s.trim());
    expect(parts).toEqual([
      "node scripts/publish-guard.mjs",
      "pnpm clean",
      "pnpm build",
      // The full check, installs included, ran in the test job; here the published build is inspected again.
      "node scripts/release-check.mjs --no-install",
      // pnpm, not npm: only pnpm turns `workspace:` ranges into the released versions.
      'pnpm -r --filter "./packages/**" publish --access public --no-git-checks',
      "node scripts/release-tags.mjs",
    ]);
  });

  it("REQ-GEN-15/AC2: a package published by hand is refused before it is packed", () => {
    const dirs = [
      ...readdirSync(join(root, "packages")).map((d) => join(root, "packages", d)),
      ...readdirSync(join(root, "packages", "adapters")).map((d) => join(root, "packages", "adapters", d)),
    ].filter((d) => existsSync(join(d, "package.json")));
    for (const dir of dirs) {
      const m = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
        private?: boolean;
        scripts?: Record<string, string>;
      };
      if (m.private === true) continue;
      const guard = /^node (\S+publish-guard\.mjs)$/.exec(m.scripts?.["prepublishOnly"] ?? "");
      expect(guard, dir).not.toBeNull();
      expect(resolve(dir, guard?.[1] ?? ""), dir).toBe(join(root, "scripts", "publish-guard.mjs"));
    }
  });
});

describe("the release check on every pull request (REQ-GEN-15/AC5)", () => {
  it("REQ-GEN-15/AC5: CI builds and runs the release check for pull requests, without credentials", () => {
    const ci = workflow("ci.yml");
    expect(Object.keys(ci.on)).toContain("pull_request");
    const steps = ci.jobs["release-check"]?.steps ?? [];
    expect(steps.find((s) => s.uses?.startsWith("actions/checkout@"))?.with?.["persist-credentials"]).toBe(
      false,
    );
    for (const step of steps) expect(secretsIn(step)).toBe(false);
    const build = index(steps, (s) => s.run === "pnpm build");
    const check = index(steps, (s) => s.run === "node scripts/release-check.mjs");
    expect(build).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(build);
    expect(scripts["release:check"]).toBe("node scripts/release-check.mjs");
  });

  it("REQ-GEN-15/AC4: the check installs the CLI without running any install script", () => {
    const source = readFileSync(join(root, "scripts", "release-check.mjs"), "utf8");
    expect(source).toMatch(/"install",\s*"--no-audit",\s*"--no-fund",\s*"--ignore-scripts"/);
  });
});
