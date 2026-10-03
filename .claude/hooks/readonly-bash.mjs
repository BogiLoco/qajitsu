#!/usr/bin/env node
// PreToolUse(Bash) for reviewer subagents (code-reviewer, security-reviewer, verification-auditor, planner):
// allows only read-only commands. Registered in the subagents' frontmatter, not in settings.json.
import { readInput, finishPreToolUse } from "./lib/hook-io.mjs";
import { evaluateBash, evaluateReadonlyBash } from "./lib/policies.mjs";

const input = readInput();
const command = input.tool_input?.command ?? "";
const general = evaluateBash(command);
finishPreToolUse(general.decision === "deny" ? general : evaluateReadonlyBash(command));
