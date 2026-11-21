#!/usr/bin/env node
// npm trusted publishing (REQ-GEN-15/AC6): every published package accepts a publish only from the Release workflow
// of this repository in its npm-publish environment, which proves itself with its OIDC token; no npm token is needed.
// Run once by a maintainer after `npm login` (an account that may change the packages' settings, npm 11.10 or later):
//   node scripts/trusted-publishing.mjs           sets the trusted publisher where it is missing, then checks all
//   node scripts/trusted-publishing.mjs --check   only checks; exits 1 when a package lacks it or trusts another
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { publishablePackages } from "./release-check.mjs";

/** The one publisher every package trusts. */
export const PUBLISHER = { repository: "BogiLoco/qajitsu", file: "release.yml", environment: "npm-publish" };

/**
 * Arguments of `npm trust github` that make the Release workflow the trusted publisher of a package.
 *
 * @param {string} name - The package.
 */
export const trustArgs = (name) => [
  "trust",
  "github",
  name,
  "--file",
  PUBLISHER.file,
  "--repository",
  PUBLISHER.repository,
  "--environment",
  PUBLISHER.environment,
  "--allow-publish",
  "--yes",
];

/** Every string inside a value, at any depth. */
const strings = (value) =>
  typeof value === "string"
    ? [value]
    : value !== null && typeof value === "object"
      ? Object.values(value).flatMap(strings)
      : [];

/**
 * Reads `npm trust list --json`: the trusted publishers that are the Release workflow, and the others. An entry is the
 * Release workflow when its values name this repository, `release.yml` (alone or as a workflow path) and the
 * npm-publish environment; anything else, another repository, workflow or environment, could publish too.
 *
 * @param {string} output - The command's standard output.
 * @returns {{ ours: number, others: number }}
 */
export function readTrust(output) {
  const text = output.trim();
  if (text === "") return { ours: 0, others: 0 };
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed)
    ? parsed
    : (Object.values(parsed ?? {}).find((v) => Array.isArray(v)) ?? [parsed]);
  let ours = 0;
  for (const entry of list) {
    const values = strings(entry).map((s) => s.toLowerCase());
    const isOurs =
      values.includes(PUBLISHER.repository.toLowerCase()) &&
      values.some((v) => v === PUBLISHER.file || v.endsWith(`/${PUBLISHER.file}`)) &&
      values.includes(PUBLISHER.environment);
    if (isOurs) ours += 1;
  }
  return { ours, others: list.length - ours };
}

/**
 * The line of npm's error output that says what went wrong, not where its log is.
 *
 * @param {string} stderr
 */
export function npmError(stderr) {
  const lines = stderr
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("npm error") && !l.includes("A complete log of this run"));
  return lines.at(-1) ?? (stderr.trim() || "no output");
}

/**
 * Checks, and unless `check` sets, the trusted publisher of every package.
 *
 * @param {readonly string[]} names - The published packages.
 * @param {(args: string[], interactive: boolean) => { status: number | null, stdout: string, stderr: string }} npm
 *   Runs npm; interactive calls let npm ask for a one-time password.
 * @param {boolean} check - Only check.
 * @returns {string[]} One problem per package that does not trust exactly the Release workflow.
 */
export function trustAll(names, npm, check) {
  const problems = [];
  for (const name of names) {
    const list = () => {
      const r = npm(["trust", "list", name, "--json"], false);
      return r.status === 0 ? readTrust(r.stdout) : { error: npmError(r.stderr) };
    };
    let trust = list();
    if (!check && "ours" in trust && trust.ours === 0 && trust.others === 0) {
      npm(trustArgs(name), true);
      trust = list();
    }
    if ("error" in trust) problems.push(`${name}: npm trust list failed: ${trust.error}`);
    else if (trust.ours === 0) problems.push(`${name}: the Release workflow is not its trusted publisher`);
    else if (trust.others > 0)
      problems.push(`${name}: ${String(trust.others)} other trusted publisher(s); revoke them on npmjs.com`);
  }
  return problems;
}

const main = () => {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const check = process.argv.includes("--check");
  const names = publishablePackages(root).map((p) => p.manifest.name);
  const npm = (args, interactive) => {
    const r = spawnSync("npm", args, { encoding: "utf8", stdio: interactive ? "inherit" : "pipe" });
    return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  };
  const problems = trustAll(names, npm, check);
  if (problems.length > 0) {
    process.stderr.write(`${problems.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(
    `All ${String(names.length)} packages trust only ${PUBLISHER.repository} ${PUBLISHER.file} (${PUBLISHER.environment}).\n` +
      "Next, per docs/releasing.md: set each package to require two-factor authentication and disallow tokens, " +
      "then revoke the npm token and delete the NPM_TOKEN secret.\n",
  );
};

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
