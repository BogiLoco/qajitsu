---
name: review-change
description: Review the current QAJitsu change with the right read-only reviewers in parallel - code-reviewer always, verification-auditor for result-integrity code, security-reviewer for secrets, exec, network or prompts - and merge their findings.
argument-hint: "[base branch, default main]"
---

# /review-change

Base branch: `$ARGUMENTS` (use `main` if empty).

1. Run `git diff --stat <base>...HEAD` and `git status --short` to see what changed, including uncommitted work.
2. Decide which reviewers apply:
   - always: `code-reviewer`
   - paths under `packages/guard`, `packages/verifier`, `packages/steps`, `packages/report`, `packages/core/src/status`, or anything healer-related: `verification-auditor`
   - secrets, masking, evidence, logging, `execa`/docker/git execution, URLs or allowlists, MCP config, prompt templates, new dependencies: `security-reviewer`
3. Launch the applicable reviewers in parallel, each with the base branch and the list of changed files.
4. Merge their output into one list ordered **Must fix → Should fix → Consider**, de-duplicated, each with file:line and the reviewer that raised it.
5. End with a single verdict: `ready`, `ready after must-fix`, or `needs rework`.

Do not fix anything in this skill. Fixing happens afterwards in the main conversation, followed by `/verify`.
