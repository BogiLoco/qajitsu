#!/usr/bin/env node
// REQ-GEN-15/AC2: pushes the tags `scripts/release-tags.mjs` created and makes one GitHub release for the version:
// the CLI's changelog for it and every package published with it. Runs in the Release workflow after publishing.

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TAGS_FILE } from "./release-tags.mjs";

/**
 * The section of a changesets CHANGELOG.md for one version, without its heading; empty when there is none.
 *
 * @param {string} changelog
 * @param {string} version
 */
export function changelogSection(changelog, version) {
  const lines = changelog.split("\n");
  const start = lines.findIndex((l) => l.trim() === `## ${version}`);
  if (start < 0) return "";
  const end = lines.findIndex((l, i) => i > start && /^## /.test(l));
  return lines
    .slice(start + 1, end < 0 ? undefined : end)
    .join("\n")
    .trim();
}

/**
 * The GitHub release for the new tags: one per version, named after the CLI, or undefined when the CLI was not
 * published in this run.
 *
 * @param {{ tag: string, packageName: string }[]} tags
 * @param {(version: string) => string} cliChangelog - The CLI's changelog section for a version.
 */
export function releaseFor(tags, cliChangelog) {
  const cli = tags.find((t) => t.packageName === "@qajitsu/cli");
  if (!cli) return undefined;
  const version = cli.tag.slice(cli.tag.lastIndexOf("@") + 1);
  const notes = [
    cliChangelog(version) || "See the changelogs of the packages.",
    "",
    "### Packages",
    "",
    ...tags.map((t) => `- \`${t.tag}\``).sort(),
    "",
    "Install: `npm install -g @qajitsu/cli`. Every package is published from CI with npm provenance.",
    "",
  ].join("\n");
  return { tag: cli.tag, title: `QAJitsu ${version}`, notes };
}

/**
 * The git configuration that lets `git push` authenticate with the workflow's token, passed through the environment
 * so the token is neither in the command line nor in `.git/config` (the checkout keeps no credentials).
 *
 * @param {Record<string, string | undefined>} env
 * @returns {Record<string, string>}
 */
export function pushAuth(env) {
  const token = env.GH_TOKEN;
  if (!token || env.GITHUB_ACTIONS !== "true") return {};
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  return {
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.https://github.com/.extraheader",
    GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${basic}`,
  };
}

const run = (cmd, args, env = {}) => {
  const r = spawnSync(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${String(r.status)})`);
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const readTags = () => {
    try {
      return JSON.parse(readFileSync(TAGS_FILE, "utf8"));
    } catch {
      return [];
    }
  };
  const tags = readTags();
  if (tags.length === 0) {
    process.stdout.write("No new tags: nothing was published in this run.\n");
  } else {
    run("git", ["push", "origin", ...tags.map((t) => `refs/tags/${t.tag}`)], pushAuth(process.env));
    const release = releaseFor(tags, (version) =>
      changelogSection(readFileSync(join(root, "packages", "cli", "CHANGELOG.md"), "utf8"), version),
    );
    if (release) {
      const notes = join(tmpdir(), "qajitsu-release-notes.md");
      writeFileSync(notes, release.notes);
      run("gh", [
        "release",
        "create",
        release.tag,
        "--verify-tag",
        "--title",
        release.title,
        "--notes-file",
        notes,
      ]);
    }
  }
}
