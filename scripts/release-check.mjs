#!/usr/bin/env node
// Release check (REQ-GEN-15/AC3..AC5): packs every package as it would be published, inspects each tarball, then
// installs the CLI from those tarballs with npm into an empty folder and runs it. Any problem refuses the release.
//
//   node scripts/release-check.mjs            pack, inspect, install and run
//   node scripts/release-check.mjs --no-install   pack and inspect only
//   node scripts/release-check.mjs --keep     keep the work folder for a look afterwards
//
// Run after `pnpm build` from a clean checkout; CI does both.

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPOSITORY_URL = "git+https://github.com/BogiLoco/qajitsu.git";
/** Largest packed size of one package; the CLI's own size is checked after the install. */
export const MAX_PACKED_BYTES = 3 * 1024 * 1024;
/** Largest installation of the CLI with its dependencies, the five core adapters included (REQ-GEN-11). */
export const MAX_INSTALL_BYTES = 200 * 1024 * 1024;

/** Files that are never published. */
const FORBIDDEN = [
  [/(^|\/)[^/]+\.(test|spec)\.[cm]?[jt]sx?$/, "a test file"],
  [/(^|\/)[^/]+\.(test|spec)\.d\.[cm]?ts(\.map)?$/, "a test file"],
  [/\.tsbuildinfo$/, "build info"],
  [/(^|\/)\.env(\.(?!example$)[^/]*)?$/, "an environment file"],
  [/(^|\/)(coverage|node_modules|\.qa-runs)\//, "a working folder"],
  [/(^|\/)[^/]+\.(pem|key|p12|pfx)$/, "a key file"],
];

/** Every file of a folder, as `/`-separated paths relative to it. */
export function filesOf(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(relative(dir, full).split(sep).join("/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** Every string target of an `exports` field. */
const exportTargets = (exp) =>
  typeof exp === "string"
    ? [exp]
    : exp !== null && typeof exp === "object"
      ? Object.values(exp).flatMap(exportTargets)
      : [];

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"];

/**
 * The problems of one unpacked package (REQ-GEN-15/AC3); empty when it can be published.
 *
 * @param {{ dir: string, expectedVersion: string, repoDir: string, packedBytes: number }} input
 *   `dir` is the unpacked `package/` folder; `repoDir` the package's folder in the repository.
 * @returns {string[]}
 */
export function inspectPackage({
  dir,
  expectedVersion,
  repoDir,
  packedBytes,
  maxPackedBytes = MAX_PACKED_BYTES,
}) {
  const problems = [];
  const files = filesOf(dir);
  const has = new Set(files);
  if (!has.has("package.json")) return ["no package.json in the tarball"];
  const m = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  const name = m.name ?? "(no name)";
  const say = (text) => problems.push(`${name}: ${text}`);

  if (m.version !== expectedVersion) say(`version ${String(m.version)}, the release is ${expectedVersion}`);
  if (m.license !== "Apache-2.0") say(`licence ${String(m.license)}, expected Apache-2.0`);
  if (m.repository?.url !== REPOSITORY_URL)
    say(`repository ${String(m.repository?.url)}, npm provenance needs ${REPOSITORY_URL}`);
  if (typeof m.engines?.node !== "string") say("no Node.js engine");
  if (m.publishConfig?.access !== "public") say("not published with public access");
  if (m.private === true) say("marked private");
  for (const field of DEPENDENCY_FIELDS)
    for (const [dep, range] of Object.entries(m[field] ?? {}))
      if (String(range).startsWith("workspace:")) say(`${field}.${dep} is still ${String(range)}`);

  // Every file the manifest names must be in the tarball.
  const named = [
    ...(typeof m.main === "string" ? [m.main] : []),
    ...(typeof m.types === "string" ? [m.types] : []),
    ...(typeof m.bin === "string" ? [m.bin] : Object.values(m.bin ?? {})),
    ...exportTargets(m.exports),
  ];
  for (const target of named) {
    const path = target.replace(/^\.\//, "");
    if (!has.has(path)) say(`names ${target}, which is not in the tarball`);
  }
  for (const [pattern, what] of FORBIDDEN)
    for (const f of files) if (pattern.test(f)) say(`carries ${what}: ${f}`);
  for (const required of ["README.md", "LICENSE", "NOTICE"]) if (!has.has(required)) say(`no ${required}`);

  // Source maps point at files that are in the package.
  for (const f of files.filter((x) => x.endsWith(".map"))) {
    let map;
    try {
      map = JSON.parse(readFileSync(join(dir, f), "utf8"));
    } catch {
      say(`${f} is not a source map`);
      continue;
    }
    for (const source of map.sources ?? []) {
      const target = join(dirname(f), source).split(sep).join("/");
      if (!has.has(target)) say(`${f} points at ${target}, which is not in the tarball`);
    }
  }

  // Build output without its source is stale: a file moved or deleted but left in dist/ (dogfood finding P5).
  for (const f of files.filter((x) => x.startsWith("dist/") && /\.(js|d\.ts)$/.test(x))) {
    const stem = f.slice("dist/".length).replace(/\.d\.ts$|\.js$/, "");
    const sources = [".ts", ".mts", ".tsx", ".js", ".mjs"].map((ext) => `src/${stem}${ext}`);
    if (!sources.some((s) => existsSync(join(repoDir, s))))
      say(`${f} has no source in the repository: stale build output`);
  }

  if (packedBytes > maxPackedBytes)
    say(
      `packed size ${String(Math.round(packedBytes / 1024))} kB, the budget is ${String(Math.round(maxPackedBytes / 1024))} kB`,
    );
  return problems;
}

/**
 * The sources of a package changed after its build (REQ-GEN-15/AC3): a `src/**\/*.ts` (not a test) whose `dist/` file
 * is missing or older. A tarball packed from such a build would not be what the repository says.
 *
 * @param {string} dir - The package folder.
 * @returns {string[]} The stale sources, relative to the package.
 */
export function staleSources(dir) {
  const src = join(dir, "src");
  if (!existsSync(src)) return [];
  return filesOf(src)
    .filter((f) => /\.m?ts$/.test(f) && !/\.d\.ts$/.test(f) && !/\.test\.m?ts$/.test(f))
    .filter((f) => {
      const built = join(dir, "dist", f.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js"));
      return !existsSync(built) || statSync(built).mtimeMs < statSync(join(src, f)).mtimeMs;
    })
    .map((f) => `src/${f}`);
}

/** The published packages of the repository with their folders and manifests. */
export function publishablePackages(root) {
  const dirs = [
    ...readdirSync(join(root, "packages")).map((d) => join(root, "packages", d)),
    ...readdirSync(join(root, "packages", "adapters")).map((d) => join(root, "packages", "adapters", d)),
  ].filter((d) => existsSync(join(d, "package.json")));
  return dirs
    .map((dir) => ({ dir, manifest: JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) }))
    .filter((p) => p.manifest.private !== true);
}

/**
 * The packages an installation of `name` needs from the release: itself and its `@qajitsu/*` dependencies, transitively.
 *
 * @param {string} name
 * @param {Map<string, { dependencies?: Record<string, string> }>} manifests - By package name.
 */
export function releaseClosure(name, manifests) {
  const out = new Set();
  const visit = (n) => {
    if (out.has(n) || !manifests.has(n)) return;
    out.add(n);
    for (const dep of Object.keys(manifests.get(n)?.dependencies ?? {})) visit(dep);
  };
  visit(name);
  return [...out].sort();
}

const run = (cmd, args, options = {}) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, ...options });
  return { code: r.status ?? (r.error ? 127 : 1), out: `${r.stdout ?? ""}${r.stderr ?? ""}`, error: r.error };
};

/**
 * Packs one package the way the release does (`pnpm pack`, which turns `workspace:` ranges into versions).
 *
 * @param {string} dir - The package folder.
 * @param {string} dest - Where the tarball goes.
 * @returns {{ tgz: string } | { error: string }}
 */
export function packPackage(dir, dest) {
  const r = run("pnpm", ["pack", "--pack-destination", dest], { cwd: dir });
  if (r.code !== 0) return { error: `pnpm pack failed\n${r.out}` };
  const file = r.out
    .trim()
    .split("\n")
    .filter((l) => l.endsWith(".tgz"))
    .at(-1);
  if (!file) return { error: "pnpm pack named no tarball" };
  return { tgz: file.startsWith("/") ? file : join(dest, file.split("/").at(-1)) };
}

/** Size of a folder in bytes. */
export function folderBytes(dir) {
  let total = 0;
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  walk(dir);
  return total;
}

/**
 * The commands the installed CLI must run (REQ-GEN-15/AC4), each with what its output must show. They need no model,
 * no QAJitsu service and no registry: the plugin comes from its tarball.
 */
export function smokeSteps({ version, tarballOf }) {
  const v = version.replace(/\./g, "\\.");
  return [
    { args: ["--version"], codes: [0], expect: [new RegExp(`^${v}\\s*$`, "m")] },
    { args: ["--help"], codes: [0], expect: [/\binit\b/, /\brun\b/, /\bplugin\b/, /\bdoctor\b/] },
    // A new project: `init` creates .qa/ from the folder and registers it. Before the release is in the registry it
    // cannot install the API runner it needs, and says so: not ready (2).
    { args: ["init", "smoke", "--yes"], codes: [0, 2], expect: [/Project smoke registered/, /runner-api/] },
    // The plugin a project needs, from its tarball, then one it does not need, added and removed again.
    {
      args: ["plugin", "add", "runner-api", "--file", tarballOf("runner-api")],
      codes: [0],
      expect: [/runner-api/],
    },
    { args: ["plugin", "list"], codes: [0], expect: [new RegExp(`✔ runner-api\\s+${v}`)] },
    { args: ["plugin", "remove", "runner-api"], codes: [3], expect: [/still used by smoke/] },
    {
      args: ["plugin", "add", "secrets-doppler", "--file", tarballOf("secrets-doppler")],
      codes: [0],
      expect: [/secrets-doppler/],
    },
    { args: ["plugin", "remove", "secrets-doppler"], codes: [0], expect: [/secrets-doppler/] },
    {
      args: ["plugin", "list"],
      codes: [0],
      expect: [/· secrets-doppler\s+not installed/, new RegExp(`✔ runner-api\\s+${v}`)],
    },
    // With what it needs installed, a new project has nothing to fix offline.
    { args: ["doctor"], codes: [0], expect: [/✔ node: Node\.js/, /✔ plugins/] },
  ];
}

/**
 * What is wrong with the spec type check of an installation (REQ-GEN-15/AC4, REQ-EXEC-03/AC1): the steps types must be
 * the installed build's, a correct spec must pass and a spec calling an unknown method must not.
 *
 * @param output - The JSON line the check printed.
 * @param app - The installation folder.
 */
export function judgeTypecheck(output, app) {
  let result;
  try {
    result = JSON.parse(output.trim().split("\n").at(-1) ?? "");
  } catch {
    return [`the spec type check did not answer:\n${output.slice(0, 2000)}`];
  }
  const out = [];
  // Whatever the layout: the build of the installed steps package, inside this installation.
  const entry = realOrSelf(result.entry);
  const inside = entry.startsWith(`${realOrSelf(app)}${sep}`);
  if (
    !inside ||
    !entry.split(sep).join("/").endsWith("/@qajitsu/steps/dist/index.d.ts") ||
    !existsSync(entry)
  )
    out.push(
      `the installed verifier type-checks specs against ${String(result.entry)}, not the installed @qajitsu/steps/dist/index.d.ts`,
    );
  if (!Array.isArray(result.good) || result.good.length > 0)
    out.push(`a correct spec fails the installed type check: ${JSON.stringify(result.good)}`);
  if (!Array.isArray(result.bad) || result.bad.length === 0)
    out.push("a spec calling an unknown method passes the installed type check");
  return out;
}

const realOrSelf = (path) => {
  try {
    return realpathSync(String(path));
  } catch {
    return String(path);
  }
};

/** A crash of the CLI rather than an answer: an uncaught error with its stack. */
export const looksLikeCrash = (output) =>
  /^\s+at .+\(.+:\d+:\d+\)$/m.test(output) || /Unhandled|ERR_MODULE_NOT_FOUND/.test(output);

async function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const argv = new Set(process.argv.slice(2));
  const work = mkdtempSync(join(tmpdir(), "qj-release-check-"));
  const problems = [];
  const log = (text) => process.stdout.write(`${text}\n`);
  try {
    const packages = publishablePackages(root);
    const version = packages.find((p) => p.manifest.name === "@qajitsu/cli")?.manifest.version;
    if (!version) throw new Error("no @qajitsu/cli package");
    for (const p of packages) {
      if (!existsSync(join(p.dir, "dist")))
        throw new Error(`${p.manifest.name} is not built: run pnpm build first`);
      const stale = staleSources(p.dir);
      if (stale.length > 0)
        throw new Error(
          `${p.manifest.name} changed after its build (${stale.slice(0, 3).join(", ")}): run pnpm build first`,
        );
    }

    // AC3: pack every package the way the release does, and inspect what would be published.
    const packs = join(work, "tarballs");
    mkdirSync(packs);
    const tarballs = new Map();
    for (const p of packages) {
      const packed = packPackage(p.dir, packs);
      if ("error" in packed) {
        problems.push(`${p.manifest.name}: ${packed.error}`);
        continue;
      }
      const tgz = packed.tgz;
      const unpacked = join(work, "unpacked", p.manifest.name.replace("/", "__"));
      mkdirSync(unpacked, { recursive: true });
      const x = run("tar", ["-xzf", tgz, "-C", unpacked]);
      if (x.code !== 0) {
        problems.push(`${p.manifest.name}: the tarball cannot be unpacked\n${x.out}`);
        continue;
      }
      const found = inspectPackage({
        dir: join(unpacked, "package"),
        expectedVersion: version,
        repoDir: p.dir,
        packedBytes: statSync(tgz).size,
      });
      problems.push(...found);
      tarballs.set(p.manifest.name, tgz);
      log(
        `${found.length === 0 ? "ok  " : "FAIL"} ${p.manifest.name.padEnd(42)} ${String(Math.round(statSync(tgz).size / 1024)).padStart(6)} kB`,
      );
    }
    if (problems.length > 0 || argv.has("--no-install")) return;

    // AC4: install the CLI from the tarballs with npm, the way a user installs it, into an empty folder. Install scripts
    // stay off: this resolves dependencies fresh from the registry, and nothing in the CLI's tree needs one.
    const manifests = new Map(packages.map((p) => [p.manifest.name, p.manifest]));
    const needed = releaseClosure("@qajitsu/cli", manifests);
    const app = join(work, "install");
    mkdirSync(app);
    writeFileSync(
      join(app, "package.json"),
      `${JSON.stringify({ name: "qj-release-check", private: true }, null, 2)}\n`,
    );
    const env = {
      PATH: process.env.PATH ?? "",
      HOME: join(work, "home"),
      TMPDIR: join(work, "tmp"),
      npm_config_cache: join(work, "npm-cache"),
      npm_config_update_notifier: "false",
    };
    mkdirSync(env.HOME);
    mkdirSync(env.TMPDIR);
    log(`installing ${String(needed.length)} packages from their tarballs with npm`);
    const install = run(
      "npm",
      ["install", "--no-audit", "--no-fund", "--ignore-scripts", ...needed.map((n) => tarballs.get(n))],
      { cwd: app, env },
    );
    if (install.code !== 0) {
      problems.push(`npm install of the CLI failed\n${install.out}`);
      return;
    }
    const installed = folderBytes(join(app, "node_modules"));
    log(`installed: ${String(Math.round(installed / 1024 / 1024))} MB`);
    if (installed > MAX_INSTALL_BYTES)
      problems.push(
        `the CLI installs ${String(Math.round(installed / 1024 / 1024))} MB, the budget is ${String(MAX_INSTALL_BYTES / 1024 / 1024)} MB`,
      );
    for (const extra of packages.map((p) => p.manifest.name).filter((n) => !needed.includes(n)))
      if (existsSync(join(app, "node_modules", ...extra.split("/"))))
        problems.push(`${extra} is installed with the CLI but should be a plugin installed on demand`);

    // The commands run in a new project folder, with no model keys and an empty home.
    const qj = join(app, "node_modules", ".bin", "qj");
    const project = join(work, "project");
    mkdirSync(project);
    writeFileSync(
      join(project, "package.json"),
      `${JSON.stringify({ name: "smoke-app", private: true }, null, 2)}\n`,
    );
    run("git", ["init", "-q", "-b", "main"], { cwd: project, env });
    const tarballOf = (id) => tarballs.get(`@qajitsu/adapter-${id}`) ?? `(no tarball for ${id})`;
    for (const step of smokeSteps({ version, tarballOf })) {
      const r = run(qj, step.args, { cwd: project, env });
      const label = `qj ${step.args.map((a) => (a.endsWith(".tgz") ? "<tarball>" : a)).join(" ")}`;
      const missing = step.expect.filter((re) => !re.test(r.out));
      const bad = !step.codes.includes(r.code) || missing.length > 0 || looksLikeCrash(r.out);
      log(`${bad ? "FAIL" : "ok  "} ${label} (exit ${String(r.code)})`);
      if (bad)
        problems.push(
          `${label}: exit ${String(r.code)} (expected ${step.codes.join(" or ")})${missing.length > 0 ? `, output lacks ${missing.map(String).join(", ")}` : ""}${looksLikeCrash(r.out) ? ", it crashed" : ""}\n${r.out.slice(0, 4000)}`,
        );
    }
    // REQ-EXEC-03/AC1 in the installation: a generated spec is type-checked against the installed steps package's
    // built types (dogfood finding P1), and a spec that calls what does not exist is caught.
    const specs = join(work, "specs");
    mkdirSync(specs);
    const good = readFileSync(join(root, "fixtures", "specs", "demo-1", "TC-01.spec.ts"), "utf8");
    writeFileSync(join(specs, "good.spec.ts"), good);
    writeFileSync(join(specs, "bad.spec.ts"), good.replace("shopper.get(", "shopper.fetchEverything("));
    // The verifier the CLI itself loads, by real path: flat for npm, in the .pnpm store for pnpm.
    const typecheckIn = (installation, label) => {
      const cli = realpathSync(join(installation, "node_modules", "@qajitsu", "cli"));
      const verifier = join(dirname(cli), "verifier", "dist", "index.js");
      const r = run(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          [
            "const { stepsTypesEntry, typecheckSpecs } = await import(process.argv[1]);",
            "const [good, bad] = process.argv.slice(2);",
            "const problems = (f) => [...typecheckSpecs([f]).values()].flat().map((p) => p.message);",
            "console.log(JSON.stringify({ entry: stepsTypesEntry(), good: problems(good), bad: problems(bad) }));",
          ].join("\n"),
          pathToFileURL(verifier).toString(),
          join(specs, "good.spec.ts"),
          join(specs, "bad.spec.ts"),
        ],
        { cwd: installation, env },
      );
      const verdict = judgeTypecheck(r.out, installation);
      log(`${verdict.length === 0 ? "ok  " : "FAIL"} spec type check with the installed verifier (${label})`);
      problems.push(...verdict.map((v) => `${label}: ${v}`));
    };
    typecheckIn(app, "npm");
    // pnpm keeps each package's dependencies next to it, in its store: the same tarballs, installed that way.
    const pnpmApp = join(work, "install-pnpm");
    mkdirSync(pnpmApp);
    writeFileSync(
      join(pnpmApp, "package.json"),
      `${JSON.stringify(
        {
          name: "qj-release-check-pnpm",
          private: true,
          dependencies: { "@qajitsu/cli": `file:${tarballs.get("@qajitsu/cli")}` },
          pnpm: { overrides: Object.fromEntries(needed.map((n) => [n, `file:${tarballs.get(n)}`])) },
        },
        null,
        2,
      )}\n`,
    );
    const pnpmInstall = run("pnpm", ["install", "--ignore-scripts", "--config.confirmModulesPurge=false"], {
      cwd: pnpmApp,
      env: { ...env, npm_config_store_dir: join(work, "pnpm-store") },
    });
    if (pnpmInstall.code !== 0)
      problems.push(`pnpm install of the CLI failed\n${pnpmInstall.out.slice(0, 4000)}`);
    else typecheckIn(pnpmApp, "pnpm");
    if (!existsSync(join(project, ".qa", "qa.project.yaml")))
      problems.push("qj init created no .qa/qa.project.yaml");
  } finally {
    if (problems.length > 0) {
      process.stderr.write(`\nRelease check refused the release (${String(problems.length)} problems):\n`);
      for (const p of problems) process.stderr.write(`- ${p}\n`);
      process.exitCode = 1;
    } else log("\nRelease check passed.");
    if (argv.has("--keep")) log(`work folder kept: ${work}`);
    else rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
