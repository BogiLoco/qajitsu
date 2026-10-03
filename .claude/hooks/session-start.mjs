#!/usr/bin/env node
// SessionStart: gives Claude a short, factual snapshot of where the project stands.
// Plain stdout from a SessionStart hook is added to Claude's context.
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readInput, projectDir } from "./lib/hook-io.mjs";

const input = readInput();
const root = projectDir(input);
const lines = [];

const git = (args) => spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 5_000 });
const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
if (branch.status === 0) {
  const changed = git(["status", "--porcelain"]).stdout.split("\n").filter(Boolean).length;
  lines.push(`Git branch: ${branch.stdout.trim()}; uncommitted files: ${changed}.`);
}

const statusFile = join(root, "docs", "STATUS.md");
if (existsSync(statusFile)) {
  const status = readFileSync(statusFile, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .slice(0, 3);
  if (status.length) lines.push(`Project status (docs/STATUS.md): ${status.join(" ")}`);
}

const checker = join(root, "scripts", "requirements.mjs");
if (existsSync(checker)) {
  const list = spawnSync(process.execPath, [checker, "list", "--status", "in-progress"], {
    cwd: root,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (list.status === 0) {
    const ids = list.stdout
      .split("\n")
      .filter(Boolean)
      .map((l) => l.split("\t")[0]);
    lines.push(
      ids.length
        ? `Requirements in progress: ${ids.slice(0, 10).join(", ")}${ids.length > 10 ? ", ..." : ""}. Catalogue: docs/requirements/.`
        : "No requirement is in progress. Catalogue: docs/requirements/ (pnpm req:list -- --stage N).",
    );
  }
}

if (!existsSync(join(root, "package.json"))) {
  lines.push(
    "The pnpm workspace skeleton does not exist yet; pnpm scripts are unavailable until it is created.",
  );
} else if (!existsSync(join(root, "node_modules"))) {
  lines.push("Dependencies are not installed; run pnpm install before tests.");
}

if (lines.length) process.stdout.write(`${lines.join("\n")}\n`);
process.exit(0);
