#!/usr/bin/env node
import { createProgram } from "./program.js";
import { readVersion } from "./version.js";

const program = createProgram(readVersion(), {
  write: (text) => process.stdout.write(text),
  writeError: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  nodeVersion: process.version,
  setExitCode: (code) => {
    process.exitCode = code;
  },
});

await program.parseAsync(process.argv);
