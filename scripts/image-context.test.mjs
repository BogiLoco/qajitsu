import { describe, expect, it } from "vitest";
import {
  contentProblems,
  demoFileAllowed,
  imageManifest,
  imagePackages,
  lockIntegrities,
  lockProblems,
  pinnedVersions,
} from "./image-context.mjs";

const integrity = (c) => `sha512-${c.repeat(86)}==`;

describe("the release image's build context (REQ-GEN-09)", () => {
  it("REQ-GEN-09/AC1: the image installs the CLI's closure and the API and web runner plugins with theirs", () => {
    const manifests = new Map([
      ["@qajitsu/cli", { dependencies: { "@qajitsu/core": "workspace:*", zod: "^4" } }],
      ["@qajitsu/core", { dependencies: {} }],
      ["@qajitsu/adapter-runner-api", { dependencies: { "@qajitsu/steps": "workspace:*" } }],
      ["@qajitsu/adapter-runner-web", { dependencies: { "@qajitsu/core": "workspace:*" } }],
      ["@qajitsu/steps", { dependencies: {} }],
      ["@qajitsu/adapter-jira", { dependencies: {} }],
    ]);
    const { cli, plugins, all } = imagePackages(manifests);
    expect([...cli].sort()).toEqual(["@qajitsu/cli", "@qajitsu/core"]);
    expect(plugins).toEqual(["@qajitsu/adapter-runner-api", "@qajitsu/adapter-runner-web"]);
    expect(all).toEqual([
      "@qajitsu/adapter-runner-api",
      "@qajitsu/adapter-runner-web",
      "@qajitsu/cli",
      "@qajitsu/core",
      "@qajitsu/steps",
    ]);
  });

  it("REQ-GEN-09/AC1: every third-party package is pinned to the one version the repository tests", () => {
    const trees = [
      {
        dependencies: {
          zod: { version: "4.1.0" },
          "@qajitsu/core": { version: "0.1.0", dependencies: { pino: { version: "9.0.0" } } },
        },
      },
      { dependencies: { pino: { version: "9.0.0", dependencies: { "sonic-boom": { version: "4.0.1" } } } } },
    ];
    expect([...pinnedVersions(trees)]).toEqual([
      ["pino", "9.0.0"],
      ["sonic-boom", "4.0.1"],
      ["zod", "4.1.0"],
    ]);
    // Two versions of one package cannot be pinned by name: refused, never one of them picked.
    const twice = [
      { dependencies: { zod: { version: "4.1.0", dependencies: { zod: { version: "3.25.0" } } } } },
    ];
    expect(() => pinnedVersions(twice)).toThrow(/zod \(4\.1\.0, 3\.25\.0\)/);
    expect(
      imageManifest(new Map([["@qajitsu/cli", "tarballs/cli.tgz"]]), new Map([["zod", "4.1.0"]])),
    ).toEqual({
      name: "qajitsu-image",
      private: true,
      dependencies: { "@qajitsu/cli": "file:tarballs/cli.tgz" },
      overrides: { zod: "4.1.0" },
    });
  });

  it("REQ-GEN-09/AC6: the generated lockfile must install exactly the pins and QAJitsu only from its tarballs", () => {
    const pins = new Map([
      ["zod", "4.1.0"],
      ["pino", "9.0.0"],
    ]);
    const good = {
      packages: {
        "": { name: "qajitsu-image" },
        "node_modules/@qajitsu/cli": { version: "0.2.0", resolved: "file:tarballs/cli.tgz" },
        "node_modules/zod": { version: "4.1.0" },
        "node_modules/@qajitsu/cli/node_modules/pino": { version: "9.0.0" },
        "node_modules/typescript": { version: "5.9.0", dev: true },
      },
    };
    expect(lockProblems(good, pins)).toEqual([]);
    const bad = {
      packages: {
        "node_modules/@qajitsu/cli": {
          version: "0.2.0",
          resolved: "https://registry.npmjs.org/@qajitsu/cli/-/cli-0.2.0.tgz",
        },
        "node_modules/zod": { version: "4.2.0" },
        "node_modules/left-pad": { version: "1.3.0" },
      },
    };
    expect(lockProblems(bad, pins)).toEqual([
      "@qajitsu/cli is not installed from its tarball",
      "zod is 4.2.0, the repository tests 4.1.0",
      "left-pad@1.3.0 is not in the repository's lockfile",
      "pino is pinned but not installed",
    ]);
  });

  it("REQ-GEN-09/AC6: integrities are read from pnpm-lock.yaml, scoped, unscoped and quoted alike", () => {
    const text = [
      "packages:",
      "",
      "  '@ai-sdk/provider@4.0.21':",
      `    resolution: {integrity: ${integrity("a")}}`,
      "    engines: {node: '>=22'}",
      "",
      "  zod@4.1.0:",
      `    resolution: {integrity: ${integrity("b")}}`,
      "",
      "  git-dep@1.0.0:",
      "    resolution: {tarball: https://example.test/git-dep.tgz}",
      "",
      "snapshots:",
      "",
      "  '@ai-sdk/provider@4.0.21':",
      "    dependencies:",
      "      json-schema: 0.4.0",
    ].join("\n");
    expect([...lockIntegrities(text)]).toEqual([
      ["@ai-sdk/provider@4.0.21", integrity("a")],
      ["zod@4.1.0", integrity("b")],
    ]);
  });

  it("REQ-GEN-09/AC6: a package from another registry or with other content than the reviewed lockfile is refused", () => {
    const reviewed = new Map([
      ["zod@4.1.0", integrity("b")],
      ["pino@9.0.0", integrity("c")],
    ]);
    const registry = (n, v) => `https://registry.npmjs.org/${n}/-/${n}-${v}.tgz`;
    const lock = {
      packages: {
        "": {},
        "node_modules/@qajitsu/cli": { version: "0.2.0", resolved: "file:tarballs/cli.tgz" },
        "node_modules/zod": {
          version: "4.1.0",
          resolved: registry("zod", "4.1.0"),
          integrity: integrity("b"),
        },
        "node_modules/pino": {
          version: "9.0.0",
          resolved: registry("pino", "9.0.0"),
          integrity: integrity("c"),
        },
        "node_modules/vitest": { version: "4.0.0", dev: true },
      },
    };
    expect(contentProblems(lock, reviewed)).toEqual([]);
    const tampered = {
      packages: {
        "node_modules/zod": {
          version: "4.1.0",
          resolved: registry("zod", "4.1.0"),
          integrity: integrity("d"),
        },
        "node_modules/pino": {
          version: "9.0.0",
          resolved: "https://mirror.example.test/pino-9.0.0.tgz",
          integrity: integrity("c"),
        },
        "node_modules/a/node_modules/left-pad": {
          version: "1.3.0",
          resolved: registry("left-pad", "1.3.0"),
          integrity: integrity("e"),
        },
        "node_modules/no-source": { version: "1.0.0" },
      },
    };
    expect(contentProblems(tampered, new Map([...reviewed, ["no-source@1.0.0", integrity("f")]]))).toEqual([
      "zod@4.1.0 has another integrity than pnpm-lock.yaml",
      "pino@9.0.0 comes from https://mirror.example.test/pino-9.0.0.tgz, not registry.npmjs.org",
      "left-pad@1.3.0 has no integrity in pnpm-lock.yaml",
      "no-source@1.0.0 comes from undefined, not registry.npmjs.org",
      "no-source@1.0.0 has another integrity than pnpm-lock.yaml",
    ]);
  });

  it("REQ-GEN-09/AC6: the demo takes no build output, dependencies, run data or environment files", () => {
    for (const ok of ["examples/demo-shop/src/app.ts", "examples/demo-shop/.env.example", "scripts/demo.mjs"])
      expect(demoFileAllowed(ok), ok).toBe(true);
    for (const no of [
      "examples/demo-shop/node_modules/x/index.js",
      "examples/demo-shop/.qa-runs/r1/results.json",
      "examples/demo-shop/android/build/app.apk",
      "examples/demo-shop/android/.gradle/cache",
      "examples/demo-shop/.env",
      "examples/demo-shop/.env.local",
      "examples/demo-shop/api/.env.production",
    ])
      expect(demoFileAllowed(no), no).toBe(false);
  });
});
