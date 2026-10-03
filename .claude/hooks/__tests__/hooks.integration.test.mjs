// End-to-end checks of the hook scripts exactly as Claude Code runs them: JSON on stdin, exit code and stdout out.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const hooksDir = join(dirname(fileURLToPath(import.meta.url)), "..");

function runHook(script, input, env = {}) {
  return spawnSync(process.execPath, [join(hooksDir, script)], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

describe("guard-bash.mjs", () => {
  test("exit 2 with reason for a denied command", () => {
    const r = runHook("guard-bash.mjs", { tool_name: "Bash", tool_input: { command: "git push --force" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /Force push is blocked/);
  });
  test("ask decision as JSON", () => {
    const r = runHook("guard-bash.mjs", { tool_name: "Bash", tool_input: { command: "git reset --hard" } });
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision, "ask");
  });
  test("silent exit 0 for an allowed command", () => {
    const r = runHook("guard-bash.mjs", { tool_name: "Bash", tool_input: { command: "pnpm verify" } });
    assert.equal(r.status, 0);
    assert.equal(r.stdout, "");
  });
  test("tolerates empty stdin", () => {
    const r = spawnSync(process.execPath, [join(hooksDir, "guard-bash.mjs")], {
      input: "",
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
  });
});

describe("protect-files.mjs", () => {
  test("blocks writing .env", () => {
    const r = runHook("protect-files.mjs", {
      tool_name: "Write",
      tool_input: { file_path: "/repo/.env", content: "X=1" },
    });
    assert.equal(r.status, 2);
  });
});

describe("readonly-bash.mjs", () => {
  test("blocks writes for reviewers", () => {
    const r = runHook("readonly-bash.mjs", {
      tool_name: "Bash",
      tool_input: { command: "git commit -am fix" },
    });
    assert.equal(r.status, 2);
  });
  test("still applies the general guard", () => {
    const r = runHook("readonly-bash.mjs", { tool_name: "Bash", tool_input: { command: "cat .env" } });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /\.env/);
  });
});

describe("post-edit.mjs", () => {
  test("reports console.log in library source with exit 2", () => {
    const root = mkdtempSync(join(tmpdir(), "qj-hooks-"));
    const file = join(root, "packages", "core", "src", "run.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export const x = 1;\nconsole.log(x);\n");
    const r = runHook(
      "post-edit.mjs",
      { tool_name: "Write", tool_input: { file_path: file } },
      { CLAUDE_PROJECT_DIR: root },
    );
    assert.equal(r.status, 2);
    assert.match(r.stderr, /run\.ts:2 console/);
  });
  test("exit 0 for clean files", () => {
    const root = mkdtempSync(join(tmpdir(), "qj-hooks-"));
    const file = join(root, "packages", "core", "src", "ok.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export const x = 1;\n");
    const r = runHook(
      "post-edit.mjs",
      { tool_name: "Write", tool_input: { file_path: file } },
      { CLAUDE_PROJECT_DIR: root },
    );
    assert.equal(r.status, 0);
  });
});

describe("stop-check-tests.mjs", () => {
  function repoWith(files) {
    const root = mkdtempSync(join(tmpdir(), "qj-stop-"));
    spawnSync("git", ["init", "-q"], { cwd: root });
    for (const [p, c] of Object.entries(files)) {
      mkdirSync(dirname(join(root, p)), { recursive: true });
      writeFileSync(join(root, p), c);
    }
    return root;
  }
  test("blocks once when src changed without tests", () => {
    const root = repoWith({ "packages/core/src/a.ts": "export const a = 1;\n" });
    const r = runHook(
      "stop-check-tests.mjs",
      { hook_event_name: "Stop", stop_hook_active: false },
      { CLAUDE_PROJECT_DIR: root },
    );
    assert.equal(r.status, 0);
    assert.equal(JSON.parse(r.stdout).decision, "block");
  });
  test("does not block again when stop_hook_active", () => {
    const root = repoWith({ "packages/core/src/a.ts": "export const a = 1;\n" });
    const r = runHook(
      "stop-check-tests.mjs",
      { hook_event_name: "Stop", stop_hook_active: true },
      { CLAUDE_PROJECT_DIR: root },
    );
    assert.equal(r.stdout, "");
  });
  test("passes when a test changed too", () => {
    const root = repoWith({ "packages/core/src/a.ts": "x", "packages/core/src/a.test.ts": "y" });
    const r = runHook("stop-check-tests.mjs", { hook_event_name: "Stop" }, { CLAUDE_PROJECT_DIR: root });
    assert.equal(r.stdout, "");
  });
  test("respects the escape hatch", () => {
    const root = repoWith({ "packages/core/src/a.ts": "x" });
    const r = runHook(
      "stop-check-tests.mjs",
      { hook_event_name: "Stop" },
      { CLAUDE_PROJECT_DIR: root, QAJITSU_ALLOW_NO_TESTS: "1" },
    );
    assert.equal(r.stdout, "");
  });
});

describe("stop-check-tests.mjs with the requirements catalogue", () => {
  function repoWithChecker(exitCode) {
    const root = mkdtempSync(join(tmpdir(), "qj-stop-req-"));
    spawnSync("git", ["init", "-q"], { cwd: root });
    mkdirSync(join(root, "scripts"), { recursive: true });
    mkdirSync(join(root, "docs", "requirements"), { recursive: true });
    writeFileSync(
      join(root, "scripts", "requirements.mjs"),
      `process.stderr.write("Requirements check failed (1 problems):\\n  - plan.md:5 REQ-PLAN-01: duplicate id\\n"); process.exit(${exitCode});`,
    );
    writeFileSync(join(root, "docs", "requirements", "plan.md"), "# Plan (PLAN)\n");
    return root;
  }
  test("blocks when the catalogue changed and the check fails", () => {
    const r = runHook(
      "stop-check-tests.mjs",
      { hook_event_name: "Stop" },
      { CLAUDE_PROJECT_DIR: repoWithChecker(1) },
    );
    const out = JSON.parse(r.stdout);
    assert.equal(out.decision, "block");
    assert.match(out.reason, /duplicate id/);
  });
  test("passes when the check passes", () => {
    const r = runHook(
      "stop-check-tests.mjs",
      { hook_event_name: "Stop" },
      { CLAUDE_PROJECT_DIR: repoWithChecker(0) },
    );
    assert.equal(r.stdout, "");
  });
});

describe("session-start.mjs", () => {
  test("mentions the missing skeleton in an empty project", () => {
    const root = mkdtempSync(join(tmpdir(), "qj-start-"));
    const r = runHook(
      "session-start.mjs",
      { hook_event_name: "SessionStart", source: "startup" },
      { CLAUDE_PROJECT_DIR: root },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /skeleton does not exist yet/);
  });
});
