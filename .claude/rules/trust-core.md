---
paths:
  - "packages/guard/**"
  - "packages/verifier/**"
  - "packages/steps/**"
  - "packages/core/src/status/**"
  - "packages/report/**"
---

# Trust core: extra rules

You are editing code that protects result integrity (see architecture invariants 1–8).

- Write the adversarial test before the change: a scripted mock agent that tries to exploit exactly what you are about to touch.
- Never relax a check to fix a failing test. If a check is wrong, explain why in the PR and get it reviewed by the `verification-auditor` agent.
- Default to deny. Unknown tool, unknown path, unparsable output, missing evidence or hash mismatch → BLOCKED or NEEDS_REVIEW, never PASSED.
- Keep this code free of LLM calls. The auditor agent lives in `packages/agents`; the verifier only consumes its structured output.
- Run `pnpm test:adversarial` in addition to `pnpm verify` before finishing.
