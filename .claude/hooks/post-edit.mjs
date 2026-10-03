#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit): formats the file with the repo's Prettier (when installed)
// and reports convention violations back to Claude (exit 2 shows stderr to Claude; the edit stays).
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { readInput, projectDir, relativeToProject } from "./lib/hook-io.mjs";
import { findEditViolations } from "./lib/policies.mjs";

const input = readInput();
const filePath = input.tool_input?.file_path;
if (!filePath || !existsSync(filePath)) process.exit(0);

const root = projectDir(input);
const rel = relativeToProject(filePath, root);

if (/\.(?:ts|mts|tsx|js|mjs|json|md|ya?ml)$/.test(filePath)) {
  const prettier = join(root, "node_modules", "prettier", "bin", "prettier.cjs");
  if (existsSync(prettier)) {
    spawnSync(process.execPath, [prettier, "--write", "--log-level", "silent", filePath], {
      cwd: root,
      timeout: 20_000,
    });
  }
}

const problems = findEditViolations(rel, readFileSync(filePath, "utf8"));
if (problems.length > 0) {
  process.stderr.write(`[qajitsu conventions]\n${problems.map((p) => `- ${p}`).join("\n")}\n`);
  process.exit(2);
}
process.exit(0);
