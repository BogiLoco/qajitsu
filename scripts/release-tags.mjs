#!/usr/bin/env node
// REQ-GEN-15/AC2: tags every published version and records the new tags for the GitHub release step. `changeset
// git-tag` reports what it created only through CHANGESETS_OUTPUT (JSON lines), so this reads that file.

import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Where the new tags are written for `scripts/github-release.mjs`. */
export const TAGS_FILE = join(process.env["RUNNER_TEMP"] ?? tmpdir(), "qajitsu-release-tags.json");

/**
 * The tags `changeset git-tag` created, from its output events; other events and broken lines are left out.
 *
 * @param {string} text - The JSON lines written to CHANGESETS_OUTPUT.
 * @returns {{ tag: string, packageName: string }[]}
 */
export function tagEvents(text) {
  const out = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type === "git-tag" && typeof event.tag === "string" && typeof event.packageName === "string")
      out.push({ tag: event.tag, packageName: event.packageName });
  }
  return out;
}

/**
 * Makes sure every tag `changeset git-tag` reported exists in the repository: a missing one is created at HEAD, and the
 * tags that still do not exist are returned. The GitHub release step pushes exactly these tags, so a reported tag that
 * is not there must stop the release here, not as a failed push later.
 *
 * @param {{ tag: string }[]} tags
 * @param {{ exists: (tag: string) => boolean, create: (tag: string) => boolean }} git
 * @returns {{ created: string[], missing: string[] }}
 */
export function ensureTags(tags, git) {
  const created = [];
  const missing = [];
  for (const { tag } of tags) {
    if (git.exists(tag)) continue;
    if (git.create(tag) && git.exists(tag)) created.push(tag);
    else missing.push(tag);
  }
  return { created, missing };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const events = join(tmpdir(), `qajitsu-changesets-${String(process.pid)}.jsonl`);
  rmSync(events, { force: true });
  const r = spawnSync("pnpm", ["exec", "changeset", "git-tag"], {
    stdio: "inherit",
    env: { ...process.env, CHANGESETS_OUTPUT: events },
  });
  if (r.status !== 0) {
    process.exitCode = r.status ?? 1;
  } else {
    const read = () => {
      try {
        return readFileSync(events, "utf8");
      } catch {
        return "";
      }
    };
    const text = read();
    const tags = tagEvents(text);
    const git = (args) => spawnSync("git", args, { encoding: "utf8" });
    const { created, missing } = ensureTags(tags, {
      exists: (tag) => git(["rev-parse", "--quiet", "--verify", `refs/tags/${tag}`]).status === 0,
      create: (tag) => {
        const r = git(["tag", tag]);
        if (r.status !== 0) process.stderr.write(`git tag ${tag}: ${r.stderr}`);
        return r.status === 0;
      },
    });
    for (const tag of created)
      process.stdout.write(`Created the tag changeset reported but did not make: ${tag}\n`);
    if (missing.length > 0) {
      process.stderr.write(`These tags were reported but do not exist: ${missing.join(", ")}\n`);
      process.exit(1);
    }
    writeFileSync(TAGS_FILE, `${JSON.stringify(tags, null, 2)}\n`);
    for (const t of tags) process.stdout.write(`New tag: ${t.tag}\n`);
    process.stdout.write(`${String(tags.length)} new tags, written to ${TAGS_FILE}\n`);
  }
}
