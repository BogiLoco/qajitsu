#!/usr/bin/env node
// Stop: if library source changed but no test changed, ask Claude to continue once and add tests.
// Also: if the requirements catalogue changed, it must still pass `req:check`.
// Escape hatch for intentional no-test changes: QAJITSU_ALLOW_NO_TESTS=1.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { readInput, projectDir } from "./lib/hook-io.mjs";
import {
  evaluateRequirementsCheck,
  evaluateStop,
  parsePorcelain,
  touchesRequirements,
} from "./lib/policies.mjs";

const input = readInput();
if (input.stop_hook_active) process.exit(0);
const root = projectDir(input);

const git = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
  cwd: root,
  encoding: "utf8",
  timeout: 10_000,
});
if (git.status !== 0) process.exit(0); // not a git repo yet, or git unavailable

const changed = parsePorcelain(git.stdout);
const block = (reason) => {
  process.stdout.write(JSON.stringify({ decision: "block", reason }));
  process.exit(0);
};

if (process.env.QAJITSU_ALLOW_NO_TESTS !== "1") {
  const result = evaluateStop(changed);
  if (result.block) block(result.reason);
}

const checker = join(root, "scripts", "requirements.mjs");
if (touchesRequirements(changed) && existsSync(checker)) {
  const check = spawnSync(process.execPath, [checker, "check"], {
    cwd: root,
    encoding: "utf8",
    timeout: 20_000,
  });
  const result = evaluateRequirementsCheck(check.status, `${check.stdout}\n${check.stderr}`);
  if (result.block) block(result.reason);
}
process.exit(0);
