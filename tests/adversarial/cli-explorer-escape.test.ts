import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEventLog, type EvidenceStore } from "@qajitsu/core";
import { afterEach, describe, expect, it } from "vitest";
import {
  argOutsideSandbox,
  createSandbox,
  removeSandbox,
  sandboxEnv,
  type CliSandbox,
} from "../../packages/cli/src/commands/cli-sandbox.js";
import { createCliExploreTools } from "../../packages/cli/src/commands/explore-cli-tools.js";

const TOOL = fileURLToPath(new URL("../../fixtures/cli-tool/tool.mjs", import.meta.url));
const sandboxes: CliSandbox[] = [];
afterEach(async () => {
  for (const s of sandboxes.splice(0)) await removeSandbox(s);
});

const store: EvidenceStore = {
  put: (meta: { readonly path: string }) => Promise.resolve({ ...meta, sha256: "0".repeat(64), size: 0 }),
  manifest: () => Promise.resolve([]),
} as unknown as EvidenceStore;

describe("REQ-EXEC-24: an explorer cannot use the tool to reach outside its sandbox", () => {
  it("arguments that are paths outside the sandbox are refused before the tool runs; nothing is written there", async () => {
    const s = await createSandbox(undefined);
    sandboxes.push(s);
    const outside = join(s.root, "..", `qj-escape-${String(process.pid)}.txt`);
    const lines: string[] = [];
    const events = createEventLog({
      ticket: "DEMO-1",
      run: "r",
      write: (l) => lines.push(l),
      now: () => new Date(0),
      mask: (v) => v,
    });
    const recorder = createCliExploreTools({
      program: process.execPath,
      baseArgs: [TOOL],
      sandbox: s,
      env: sandboxEnv(s, "http://127.0.0.1:9", {}),
      timeoutMs: 10_000,
      store,
      mask: (t) => t,
      events,
      maxSteps: 20,
      now: () => new Date(),
    });
    const run = (args: string[]) => {
      const tool = recorder.tools.find((t) => t.name === "cli_run");
      if (!tool) throw new Error("cli_run missing");
      return tool.execute({ args });
    };
    for (const args of [
      ["write", outside],
      ["write", "../../escape.txt"],
      ["write", "~/.ssh/authorized_keys"],
      ["write", `--out=${outside}`],
      ["write", "/etc/passwd"],
    ])
      expect(await run(args)).toMatch(/^REFUSED: /);
    expect(await stat(outside).catch(() => undefined)).toBeUndefined();
    expect(recorder.actions).toHaveLength(0);
    expect(lines.filter((l) => l.includes('"explore.refused"'))).toHaveLength(5);
    // Inside the sandbox, URLs and plain words are fine.
    expect(await run(["write", "inside.txt"])).toContain("A01 exit code 0");
    expect(await readFile(join(s.work, "inside.txt"), "utf8")).toBe("written\n");
    expect(await run(["hello", "https://example.test/a/../b", "a..b"])).toContain("A02 exit code 0");
    expect(argOutsideSandbox(s, join(s.work, "sub", "f.txt"))).toBe(false);
    expect(argOutsideSandbox(s, "C:\\Windows\\x")).toBe(true);
  });

  it("the explorer has no tool that writes results, evidence or statuses: only commands in the sandbox and observations", async () => {
    const s = await createSandbox(undefined);
    sandboxes.push(s);
    const recorder = createCliExploreTools({
      program: process.execPath,
      baseArgs: [TOOL],
      sandbox: s,
      env: sandboxEnv(s, "http://127.0.0.1:9", {}),
      timeoutMs: 10_000,
      store,
      mask: (t) => t,
      events: createEventLog({
        ticket: "DEMO-1",
        run: "r",
        write: () => undefined,
        now: () => new Date(0),
        mask: (v) => v,
      }),
      maxSteps: 20,
      now: () => new Date(),
    });
    expect(recorder.tools.map((t) => t.name).sort()).toEqual([
      "cli_leftovers",
      "cli_list",
      "cli_read",
      "cli_run",
      "cli_send",
      "cli_signal",
      "cli_start",
      "cli_wait",
      "record_observation",
    ]);
  });
});
