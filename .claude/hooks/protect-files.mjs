#!/usr/bin/env node
// PreToolUse(Edit|Write|MultiEdit|NotebookEdit): protects .env files, the lockfile, run workspaces,
// and blocks content that looks like real credentials.
import { readInput, finishPreToolUse } from "./lib/hook-io.mjs";
import { evaluateFileEdit } from "./lib/policies.mjs";

const input = readInput();
finishPreToolUse(evaluateFileEdit(input.tool_name ?? "", input.tool_input ?? {}));
