import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_PACKED_BYTES,
  REPOSITORY_URL,
  filesOf,
  folderBytes,
  inspectPackage,
  judgeTypecheck,
  looksLikeCrash,
  releaseClosure,
  smokeSteps,
} from "./release-check.mjs";

const dirs = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const write = (root, files) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), typeof content === "string" ? content : JSON.stringify(content));
  }
};

const MANIFEST = {
  name: "@qajitsu/sample",
  version: "0.1.0",
  license: "Apache-2.0",
  repository: { type: "git", url: REPOSITORY_URL, directory: "packages/sample" },
  engines: { node: ">=22.12.0" },
  publishConfig: { access: "public", provenance: true },
  exports: {
    ".": { "qajitsu-source": "./src/index.ts", types: "./dist/index.d.ts", import: "./dist/index.js" },
  },
  bin: { qj: "./dist/bin.js" },
  dependencies: { "@qajitsu/core": "0.1.0", zod: "^4.0.0" },
};

/** The files without the named ones. */
const without = (files, ...names) =>
  Object.fromEntries(Object.entries(files).filter(([k]) => !names.includes(k)));

const CLEAN = {
  "package.json": MANIFEST,
  "README.md": "# @qajitsu/sample",
  LICENSE: "Apache License",
  NOTICE: "QAJitsu",
  "src/index.ts": "export const a = 1;",
  "src/bin.ts": "",
  "dist/index.js": "export const a = 1;",
  "dist/index.d.ts": "export declare const a = 1;",
  "dist/index.js.map": { version: 3, sources: ["../src/index.ts"] },
  "dist/bin.js": "",
};

/** An unpacked tarball and the package's folder in the repository. */
const pkg = (files = CLEAN, repo = { "src/index.ts": "", "src/bin.ts": "" }) => {
  const root = mkdtempSync(join(tmpdir(), "qj-inspect-"));
  dirs.push(root);
  write(join(root, "package"), files);
  write(join(root, "repo"), repo);
  return { dir: join(root, "package"), repoDir: join(root, "repo") };
};

const inspect = (files, overrides = {}) =>
  inspectPackage({ ...pkg(files), expectedVersion: "0.1.0", packedBytes: 10_000, ...overrides });

describe("release check: what a tarball may carry (REQ-GEN-15/AC3)", () => {
  it("REQ-GEN-15/AC3: a complete package passes", () => {
    expect(inspect(CLEAN)).toEqual([]);
  });

  it("REQ-GEN-15/AC3: a workspace dependency, another version or missing metadata refuses the release", () => {
    const bad = {
      ...CLEAN,
      "package.json": {
        ...MANIFEST,
        version: "0.0.0",
        license: "MIT",
        repository: { url: "https://github.com/someone/fork" },
        engines: undefined,
        publishConfig: undefined,
        private: true,
        dependencies: { "@qajitsu/core": "workspace:*" },
        peerDependencies: { "@qajitsu/steps": "workspace:^" },
      },
    };
    expect(inspect(bad)).toEqual([
      "@qajitsu/sample: version 0.0.0, the release is 0.1.0",
      "@qajitsu/sample: licence MIT, expected Apache-2.0",
      `@qajitsu/sample: repository https://github.com/someone/fork, npm provenance needs ${REPOSITORY_URL}`,
      "@qajitsu/sample: no Node.js engine",
      "@qajitsu/sample: not published with public access",
      "@qajitsu/sample: marked private",
      "@qajitsu/sample: dependencies.@qajitsu/core is still workspace:*",
      "@qajitsu/sample: peerDependencies.@qajitsu/steps is still workspace:^",
    ]);
  });

  it("REQ-GEN-15/AC3: every file the manifest names must be in the tarball", () => {
    const rest = without(CLEAN, "dist/bin.js", "src/index.ts", "dist/index.d.ts");
    expect(
      inspect({
        ...rest,
        "package.json": { ...MANIFEST, main: "./dist/main.js", types: "./dist/main.d.ts" },
      }),
    ).toEqual([
      "@qajitsu/sample: names ./dist/main.js, which is not in the tarball",
      "@qajitsu/sample: names ./dist/main.d.ts, which is not in the tarball",
      "@qajitsu/sample: names ./dist/bin.js, which is not in the tarball",
      "@qajitsu/sample: names ./src/index.ts, which is not in the tarball",
      "@qajitsu/sample: names ./dist/index.d.ts, which is not in the tarball",
      "@qajitsu/sample: dist/index.js.map points at src/index.ts, which is not in the tarball",
    ]);
    // A bin given as one string counts too.
    expect(inspect({ ...CLEAN, "package.json": { ...MANIFEST, bin: "./dist/cli.js" } })).toEqual([
      "@qajitsu/sample: names ./dist/cli.js, which is not in the tarball",
    ]);
  });

  it("REQ-GEN-15/AC3: tests, build info, environment and key files and working folders are never published", () => {
    const problems = inspect({
      ...CLEAN,
      "src/a.test.ts": "",
      "dist/a.test.js": "",
      "dist/a.test.d.ts": "",
      "src/b.spec.mjs": "",
      "tsconfig.tsbuildinfo": "",
      ".env": "SECRET=1",
      ".env.local": "",
      ".env.example": "# fine",
      "coverage/index.html": "",
      "certs/server.pem": "",
      "node_modules/x/index.js": "",
    });
    expect(problems.filter((p) => p.includes("carries"))).toEqual([
      "@qajitsu/sample: carries a test file: dist/a.test.js",
      "@qajitsu/sample: carries a test file: src/a.test.ts",
      "@qajitsu/sample: carries a test file: src/b.spec.mjs",
      "@qajitsu/sample: carries a test file: dist/a.test.d.ts",
      "@qajitsu/sample: carries build info: tsconfig.tsbuildinfo",
      "@qajitsu/sample: carries an environment file: .env",
      "@qajitsu/sample: carries an environment file: .env.local",
      "@qajitsu/sample: carries a working folder: coverage/index.html",
      "@qajitsu/sample: carries a working folder: node_modules/x/index.js",
      "@qajitsu/sample: carries a key file: certs/server.pem",
    ]);
  });

  it("REQ-GEN-15/AC3: a package without its licence or readme, or over its size, is refused", () => {
    const rest = without(CLEAN, "LICENSE", "README.md", "NOTICE");
    expect(inspect(rest)).toEqual([
      "@qajitsu/sample: no README.md",
      "@qajitsu/sample: no LICENSE",
      "@qajitsu/sample: no NOTICE",
    ]);
    expect(inspect(CLEAN, { packedBytes: MAX_PACKED_BYTES + 1 })).toEqual([
      `@qajitsu/sample: packed size ${String(Math.round((MAX_PACKED_BYTES + 1) / 1024))} kB, the budget is ${String(MAX_PACKED_BYTES / 1024)} kB`,
    ]);
    expect(inspect({ README: "no manifest" })).toEqual(["no package.json in the tarball"]);
  });

  it("REQ-GEN-15/AC3: stale build output and broken source maps are found", () => {
    const { dir, repoDir } = pkg(
      {
        ...CLEAN,
        "dist/moved.js": "",
        "dist/moved.d.ts": "",
        "dist/sub/kept.js": "",
        "dist/broken.js.map": "not json",
        "dist/other.js.map": { version: 3, sources: ["../src/gone.ts"] },
      },
      {
        "src/index.ts": "",
        "src/bin.ts": "",
        "src/sub/kept.ts": "",
        "src/broken.ts": "",
        "src/other.ts": "",
      },
    );
    expect(inspectPackage({ dir, repoDir, expectedVersion: "0.1.0", packedBytes: 1 })).toEqual([
      "@qajitsu/sample: dist/broken.js.map is not a source map",
      "@qajitsu/sample: dist/other.js.map points at src/gone.ts, which is not in the tarball",
      "@qajitsu/sample: dist/moved.d.ts has no source in the repository: stale build output",
      "@qajitsu/sample: dist/moved.js has no source in the repository: stale build output",
    ]);
  });
});

describe("release check: installing and running the CLI (REQ-GEN-15/AC4)", () => {
  it("REQ-GEN-15/AC4: the CLI installs with its QAJitsu dependencies only, transitively", () => {
    const manifests = new Map([
      [
        "@qajitsu/cli",
        { dependencies: { "@qajitsu/core": "0.1.0", "@qajitsu/adapter-files": "0.1.0", zod: "^4" } },
      ],
      ["@qajitsu/adapter-files", { dependencies: { "@qajitsu/core": "0.1.0" } }],
      ["@qajitsu/core", { dependencies: { zod: "^4" } }],
      ["@qajitsu/adapter-runner-api", { dependencies: { "@qajitsu/core": "0.1.0" } }],
    ]);
    expect(releaseClosure("@qajitsu/cli", manifests)).toEqual([
      "@qajitsu/adapter-files",
      "@qajitsu/cli",
      "@qajitsu/core",
    ]);
    expect(releaseClosure("@qajitsu/unknown", manifests)).toEqual([]);
  });

  it("REQ-GEN-15/AC4: the commands check their output, not only their exit code", () => {
    const steps = smokeSteps({ version: "0.1.0", tarballOf: (id) => `/t/${id}.tgz` });
    expect(steps.map((s) => `${s.args.join(" ")} -> ${s.codes.join("|")}`)).toEqual([
      "--version -> 0",
      "--help -> 0",
      "init smoke --yes -> 0|2",
      "plugin add runner-api --file /t/runner-api.tgz -> 0",
      "plugin list -> 0",
      // A plugin the project needs is never removed.
      "plugin remove runner-api -> 3",
      "plugin add secrets-doppler --file /t/secrets-doppler.tgz -> 0",
      "plugin remove secrets-doppler -> 0",
      "plugin list -> 0",
      "doctor -> 0",
    ]);
    const passes = (step, out) => (step?.expect ?? []).every((re) => re.test(out));
    expect(passes(steps[0], "0.1.0\n")).toBe(true);
    expect(passes(steps[0], "0.1.01\n")).toBe(false);
    expect(passes(steps[0], "0x1x0\n")).toBe(false);
    expect(passes(steps[4], "  ✔ runner-api             0.1.0 file /t/runner-api.tgz")).toBe(true);
    expect(passes(steps[4], "  ✘ runner-api             not installed; needed by test runs")).toBe(false);
    expect(passes(steps[8], "  · secrets-doppler   not installed\n  ✔ runner-api   0.1.0")).toBe(true);
    expect(passes(steps[8], "  ✔ secrets-doppler   0.1.0\n  ✔ runner-api   0.1.0")).toBe(false);
    expect(passes(steps[9], "✔ node: Node.js v22.12.0\n✔ plugins: every needed plugin is installed")).toBe(
      true,
    );
    expect(passes(steps[9], "✔ node: Node.js v22.12.0\n✘ plugins: runner-api missing")).toBe(false);
  });

  it("REQ-GEN-15/AC4 + REQ-EXEC-03/AC1: the installed spec type check uses the installed build and tells good from bad", () => {
    const root = mkdtempSync(join(tmpdir(), "qj-judge-"));
    dirs.push(root);
    const app = join(root, "app");
    const flat = join(app, "node_modules", "@qajitsu", "steps", "dist", "index.d.ts");
    const store = join(
      app,
      "node_modules",
      ".pnpm",
      "@qajitsu+steps@0.1.0",
      "node_modules",
      "@qajitsu",
      "steps",
      "dist",
      "index.d.ts",
    );
    write(root, {
      "app/node_modules/@qajitsu/steps/dist/index.d.ts": "",
      [`app/${store.slice(app.length + 1)}`]: "",
      "elsewhere/@qajitsu/steps/dist/index.d.ts": "",
    });
    const ok = (entry) =>
      judgeTypecheck(JSON.stringify({ entry, good: [], bad: ["no fetchEverything"] }), app);
    expect(ok(flat)).toEqual([]);
    expect(ok(store)).toEqual([]);
    // Types outside the installation, the shipped sources or a file that is not there are refused.
    const outside = join(root, "elsewhere", "@qajitsu", "steps", "dist", "index.d.ts");
    expect(ok(outside)[0]).toMatch(/not the installed @qajitsu\/steps\/dist\/index\.d\.ts/);
    expect(ok(join(app, "node_modules", "@qajitsu", "steps", "src", "index.ts"))).toHaveLength(1);
    expect(ok(join(app, "node_modules", "@qajitsu", "steps", "dist", "gone.d.ts"))).toHaveLength(1);
    expect(judgeTypecheck(JSON.stringify({ entry: flat, good: ["x"], bad: [] }), app)).toEqual([
      'a correct spec fails the installed type check: ["x"]',
      "a spec calling an unknown method passes the installed type check",
    ]);
    expect(judgeTypecheck("Error: Cannot find package", app)[0]).toMatch(/did not answer/);
  });

  it("REQ-GEN-15/AC4: a crash is told apart from an answer", () => {
    expect(looksLikeCrash("TypeError: x\n    at main (file:///x/dist/bin.js:10:5)")).toBe(true);
    expect(looksLikeCrash("Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@qajitsu/core'")).toBe(true);
    expect(looksLikeCrash("Unhandled promise rejection")).toBe(true);
    expect(looksLikeCrash("Node.js 22.12.0 ok\nDocker: not found (needed for --build)")).toBe(false);
  });

  it("REQ-GEN-15/AC4: files and sizes of a folder are counted", () => {
    const root = mkdtempSync(join(tmpdir(), "qj-files-"));
    dirs.push(root);
    write(root, { "a.txt": "12345", "b/c.txt": "123" });
    expect(filesOf(root)).toEqual(["a.txt", "b/c.txt"]);
    expect(folderBytes(root)).toBe(8);
  });
});
