#!/usr/bin/env node
import { spawn } from "node:child_process";
import { homedir, userInfo } from "node:os";
import { createInterface } from "node:readline/promises";
import { createGitExec } from "@qajitsu/core";
import { createProgram } from "./program.js";
import { readVersion } from "./version.js";

const interactive = process.stdin.isTTY && process.env["CI"] === undefined;

const program = createProgram(readVersion(), {
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  nodeVersion: process.version,
  setExitCode: (code) => {
    process.exitCode = code;
  },
  user: process.env["QAJITSU_USER"] ?? userInfo().username,
  openEditor: (file: string) =>
    new Promise<void>((resolve, reject) => {
      // $EDITOR may carry flags ("code -w"); split it into an argument array, never a shell string.
      const [cmd = "vi", ...args] = (process.env["VISUAL"] ?? process.env["EDITOR"] ?? "vi")
        .split(/\s+/)
        .filter(Boolean);
      spawn(cmd, [...args, file], { stdio: "inherit" })
        .on("exit", () => {
          resolve();
        })
        .on("error", reject);
    }),
  ports: {
    env: process.env,
    home: homedir(),
    now: () => new Date(),
    random: Math.random,
    fetch: globalThis.fetch,
    gitExec: createGitExec(process.env),
  },
  ...(interactive
    ? {
        ask: async (question: string) => {
          const rl = createInterface({ input: process.stdin, output: process.stderr });
          try {
            return await rl.question(question);
          } finally {
            rl.close();
          }
        },
      }
    : {}),
});

await program.parseAsync(process.argv);
