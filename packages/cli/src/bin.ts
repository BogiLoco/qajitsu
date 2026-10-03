#!/usr/bin/env node
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
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
  // Argument arrays only, never a shell string (security rules).
  openFile: (file: string) =>
    new Promise<void>((resolve) => {
      const [cmd, args] =
        process.platform === "darwin"
          ? ["open", [file]]
          : process.platform === "win32"
            ? ["explorer", [file]]
            : ["xdg-open", [file]];
      execFile(cmd, args, () => {
        resolve();
      });
    }),
  compressVideo: (input: string, output: string) =>
    new Promise<boolean>((resolve) => {
      execFile(
        "ffmpeg",
        [
          "-y",
          "-loglevel",
          "error",
          "-i",
          input,
          "-vf",
          "scale=960:-2",
          "-c:v",
          "libx264",
          "-crf",
          "32",
          "-preset",
          "veryfast",
          "-an",
          output,
        ],
        (error) => {
          resolve(error === null);
        },
      );
    }),
  openTrace: (file: string) =>
    new Promise<void>((resolve) => {
      // cli.js is the package's bin entry; it is not in the exports map, so resolve it next to package.json.
      const cli = join(dirname(createRequire(import.meta.url).resolve("playwright-core")), "cli.js");
      spawn(process.execPath, [cli, "show-trace", file], { stdio: "inherit" }).on("exit", () => {
        resolve();
      });
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
