#!/usr/bin/env node
// Part of `pnpm verify` (REQ-NFR-06/AC2): the web runner's tests drive a real Chromium. On a fresh machine it is
// downloaded once into Playwright's cache; afterwards this is a no-op. Linux system libraries are not installed here
// (that needs root): run `pnpm --filter @qajitsu/cli exec playwright-core install-deps chromium` once if launching fails.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(new URL("../packages/cli/package.json", import.meta.url));
const { chromium } = require("playwright-core");
if (!existsSync(chromium.executablePath())) {
  process.stdout.write("Chromium for the web runner tests is missing; downloading it once…\n");
  const cli = join(dirname(require.resolve("playwright-core")), "cli.js");
  execFileSync(process.execPath, [cli, "install", "chromium"], { stdio: "inherit" });
}
