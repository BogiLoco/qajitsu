#!/usr/bin/env node
// PreToolUse(Bash): blocks destructive, secret-leaking and policy-breaking shell commands.
import { readInput, finishPreToolUse } from "./lib/hook-io.mjs";
import { evaluateBash } from "./lib/policies.mjs";

const input = readInput();
finishPreToolUse(evaluateBash(input.tool_input?.command ?? ""));
