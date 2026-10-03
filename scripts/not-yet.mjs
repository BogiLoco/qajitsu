#!/usr/bin/env node
// Placeholder for scripts whose implementation belongs to a later roadmap stage.
// Fails loudly so nobody mistakes a missing feature for a passing one.
const [, , name = "this command", when = "a later roadmap stage"] = process.argv;
process.stderr.write(`'${name}' is not implemented yet; it arrives in ${when}. See docs/roadmap.md.\n`);
process.exit(1);
