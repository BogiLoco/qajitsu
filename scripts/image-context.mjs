#!/usr/bin/env node
// Build context of the release image (REQ-GEN-09): the QAJitsu tarballs (the CLI with its packages and the API and
// web runner plugins, which become part of the installation), a lockfile that pins every third-party package to the
// version this repository's lockfile tests, and the offline demo (AC5). Nothing else of the repository: the image
// installs exactly what CI tested.
//
//   node scripts/image-context.mjs <dir>                    tarballs packed from this checkout (pull requests)
//   node scripts/image-context.mjs <dir> --from-registry    the published tarballs of this version (the release)
//
// Run after `pnpm build`.

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { packPackage, publishablePackages, releaseClosure, staleSources } from "./release-check.mjs";

/** The plugins the image comes with, installed next to the CLI so the same lockfile pins them. */
export const IMAGE_PLUGINS = ["runner-api", "runner-web"];

/** What of the repository the demo needs, relative to its root (only files git tracks are taken). */
export const DEMO_FILES = [
  "scripts/demo.mjs",
  "examples/demo-shop",
  "fixtures/plans/demo-1-draft.json",
  "fixtures/specs/demo-1",
];

/** Files of the demo shop that never go into the image: builds, dependencies, run data, environment files. */
export const demoFileAllowed = (path) =>
  !/(^|\/)(node_modules|\.qa-runs|build|\.gradle)(\/|$)/.test(path) &&
  !/(^|\/)\.env(\.(?!example$)[^/]*)?$/.test(path);

/**
 * The QAJitsu packages the image installs: the CLI's release closure and the plugins it comes with, with theirs.
 *
 * @param {Map<string, { dependencies?: Record<string, string> }>} manifests - By package name.
 */
export function imagePackages(manifests) {
  const cli = releaseClosure("@qajitsu/cli", manifests);
  const plugins = IMAGE_PLUGINS.map((id) => `@qajitsu/adapter-${id}`).filter((n) => manifests.has(n));
  const all = new Set(cli);
  for (const p of plugins) for (const n of releaseClosure(p, manifests)) all.add(n);
  return { cli, plugins, all: [...all].sort() };
}

/**
 * The version of every third-party package in the repository's lockfile for the given production trees, from
 * `pnpm list --json`. A package resolved at two versions cannot be pinned by name and is refused.
 *
 * @param {{ dependencies?: Record<string, { version?: string, dependencies?: object }> }[]} trees
 * @returns {Map<string, string>}
 */
export function pinnedVersions(trees) {
  const found = new Map();
  const walk = (deps) => {
    for (const [name, dep] of Object.entries(deps ?? {})) {
      if (!name.startsWith("@qajitsu/") && typeof dep.version === "string") {
        const seen = found.get(name) ?? new Set();
        seen.add(dep.version);
        found.set(name, seen);
      }
      walk(dep.dependencies);
    }
  };
  for (const tree of trees) walk(tree.dependencies);
  const twice = [...found].filter(([, v]) => v.size > 1);
  if (twice.length > 0)
    throw new Error(
      `resolved at more than one version, so they cannot be pinned: ${twice.map(([n, v]) => `${n} (${[...v].join(", ")})`).join("; ")}`,
    );
  return new Map([...found].map(([n, v]) => [n, [...v][0]]).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The image's own package.json: every QAJitsu package from its tarball, every third-party package pinned with an npm
 * override to the version the repository's lockfile tests.
 *
 * @param {Map<string, string>} tarballs - QAJitsu package name to its tarball, relative to the context.
 * @param {Map<string, string>} pins - Third-party package name to its version.
 */
export function imageManifest(tarballs, pins) {
  return {
    name: "qajitsu-image",
    private: true,
    dependencies: Object.fromEntries([...tarballs].map(([n, file]) => [n, `file:${file}`])),
    overrides: Object.fromEntries(pins),
  };
}

/**
 * What in the generated lockfile is not what the repository tests: a third-party package at another version or not
 * pinned at all, a QAJitsu package not from its tarball, a pinned package that is missing.
 *
 * @param {{ packages?: Record<string, { version?: string, resolved?: string, dev?: boolean, link?: boolean }> }} lock
 * @param {Map<string, string>} pins
 */
export function lockProblems(lock, pins) {
  const out = [];
  const present = new Set();
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || entry.dev === true) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (name.startsWith("@qajitsu/")) {
      if (!String(entry.resolved ?? "").startsWith("file:"))
        out.push(`${name} is not installed from its tarball`);
      continue;
    }
    present.add(name);
    const pin = pins.get(name);
    if (pin === undefined) out.push(`${name}@${String(entry.version)} is not in the repository's lockfile`);
    else if (entry.version !== pin)
      out.push(`${name} is ${String(entry.version)}, the repository tests ${pin}`);
  }
  for (const name of pins.keys()) if (!present.has(name)) out.push(`${name} is pinned but not installed`);
  return out;
}

/**
 * The integrity of every package version in a pnpm lockfile (`name@version` to `sha512-...`), read without a YAML
 * library so this runs no dependency code.
 *
 * @param {string} text - `pnpm-lock.yaml`.
 * @returns {Map<string, string>}
 */
export function lockIntegrities(text) {
  const out = new Map();
  const re =
    /^ {2}'?((?:@[^/\s'@]+\/)?[^@\s'(]+)@([^\s'(:]+)'?:\n {4}resolution: \{integrity: (sha512-[A-Za-z0-9+/=]+)\}/gm;
  for (const m of text.matchAll(re)) out.set(`${m[1] ?? ""}@${m[2] ?? ""}`, m[3] ?? "");
  return out;
}

/**
 * Third-party entries of the image's lockfile whose content is not what the repository's lockfile reviewed: another
 * registry, or another integrity than `pnpm-lock.yaml` has for that version (REQ-GEN-09: content-addressed pins).
 *
 * @param {{ packages?: Record<string, { version?: string, resolved?: string, integrity?: string, dev?: boolean }> }} lock
 * @param {Map<string, string>} integrities - From {@link lockIntegrities}.
 */
export function contentProblems(lock, integrities) {
  const out = [];
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (path === "" || entry.dev === true) continue;
    const name = path.slice(path.lastIndexOf("node_modules/") + "node_modules/".length);
    if (name.startsWith("@qajitsu/")) continue;
    const key = `${name}@${String(entry.version)}`;
    if (!String(entry.resolved ?? "").startsWith("https://registry.npmjs.org/"))
      out.push(`${key} comes from ${String(entry.resolved)}, not registry.npmjs.org`);
    const reviewed = integrities.get(key);
    if (reviewed === undefined) out.push(`${key} has no integrity in pnpm-lock.yaml`);
    else if (entry.integrity !== reviewed) out.push(`${key} has another integrity than pnpm-lock.yaml`);
  }
  return out;
}

const run = (cmd, args, cwd) => {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed\n${r.stdout ?? ""}${r.stderr ?? ""}`);
  return r.stdout;
};

/**
 * Writes the build context.
 *
 * @param {string} root - The repository.
 * @param {string} out - The context folder.
 * @param {{ fromRegistry?: boolean }} [options] - Take the published tarballs instead of packing this checkout.
 */
export function writeImageContext(root, out, options = {}) {
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`${out} is not empty`);
  const packages = publishablePackages(root);
  const manifests = new Map(packages.map((p) => [p.manifest.name, p.manifest]));
  const version = manifests.get("@qajitsu/cli")?.version;
  if (!version) throw new Error("no @qajitsu/cli package");
  // From the registry nothing of this checkout is packed, so nothing has to be built (and no build tool runs).
  for (const p of options.fromRegistry === true ? [] : packages) {
    if (!existsSync(join(p.dir, "dist")))
      throw new Error(`${p.manifest.name} is not built: run pnpm build first`);
    const stale = staleSources(p.dir);
    if (stale.length > 0)
      throw new Error(
        `${p.manifest.name} changed after its build (${stale.slice(0, 3).join(", ")}): run pnpm build first`,
      );
  }
  const { cli, plugins, all } = imagePackages(manifests);
  const dest = join(out, "tarballs");
  mkdirSync(dest, { recursive: true });
  const tarballs = new Map();
  for (const name of all) {
    if (options.fromRegistry === true) {
      // The bytes that were published, checked by npm against the registry's integrity.
      const file = run("npm", ["pack", `${name}@${version}`, "--pack-destination", dest, "--silent"], out)
        .trim()
        .split("\n")
        .at(-1);
      if (!file) throw new Error(`npm pack ${name}@${version} named no tarball`);
      tarballs.set(name, relative(out, join(dest, file)));
      continue;
    }
    const dir = packages.find((p) => p.manifest.name === name)?.dir;
    if (dir === undefined) throw new Error(`${name} is not a package of this repository`);
    const r = packPackage(dir, dest);
    if ("error" in r) throw new Error(`${name}: ${r.error}`);
    tarballs.set(name, relative(out, r.tgz));
  }
  // The versions the repository's lockfile resolves for the production trees of the CLI and the plugins.
  const trees = JSON.parse(
    run(
      "pnpm",
      [
        "list",
        "--prod",
        "--depth",
        "Infinity",
        "--json",
        ...[...cli, ...plugins].flatMap((n) => ["--filter", n]),
      ],
      root,
    ),
  );
  const pins = pinnedVersions(trees);
  writeFileSync(join(out, "package.json"), `${JSON.stringify(imageManifest(tarballs, pins), null, 2)}\n`);
  // The lockfile only: nothing is installed and no script runs here; the image installs it with `npm ci`.
  run(
    "npm",
    ["install", "--package-lock-only", "--ignore-scripts", "--no-audit", "--no-fund", "--omit=dev"],
    out,
  );
  const lock = JSON.parse(readFileSync(join(out, "package-lock.json"), "utf8"));
  const problems = [
    ...lockProblems(lock, pins),
    ...contentProblems(lock, lockIntegrities(readFileSync(join(root, "pnpm-lock.yaml"), "utf8"))),
  ];
  if (problems.length > 0)
    throw new Error(`the image's lockfile is not what the repository tests:\n- ${problems.join("\n- ")}`);
  // Only what git tracks: a local build never takes an untracked key or env file into the image.
  const tracked = run("git", ["ls-files", "-z", "--", ...DEMO_FILES], root)
    .split("\0")
    .filter((f) => f !== "" && demoFileAllowed(f));
  for (const file of tracked) {
    mkdirSync(dirname(join(out, "demo", file)), { recursive: true });
    cpSync(join(root, file), join(out, "demo", file));
  }
  cpSync(join(root, "ci", "docker", "entrypoint.sh"), join(out, "entrypoint.sh"));
  const manifest = {
    version,
    packages: all,
    plugins: plugins.map((n) => n.replace("@qajitsu/adapter-", "")),
    pinned: pins.size,
    from: options.fromRegistry === true ? "registry" : "checkout",
  };
  writeFileSync(join(out, "image.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2];
  if (!out) {
    process.stderr.write("usage: node scripts/image-context.mjs <dir> [--from-registry]\n");
    process.exitCode = 1;
  } else {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
    try {
      const m = writeImageContext(root, resolve(out), {
        fromRegistry: process.argv.includes("--from-registry"),
      });
      process.stdout.write(
        `Image context for ${m.version} (from the ${m.from}): ${String(m.packages.length)} QAJitsu packages, ${String(m.pinned)} pinned dependencies, plugins ${m.plugins.join(", ")}\n`,
      );
    } catch (error) {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    }
  }
}
