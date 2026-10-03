# Adversarial tests

Attacks on result integrity: lying agents, tampered artifacts, broken runner output, prompt injection. Every protection in `packages/guard`, `packages/verifier`, `packages/steps` and status/report code has a test here that fails when the protection is removed. These tests block merges.

- Naming: `<what-the-attacker-tries>.test.ts`, test titles start with the invariant and the requirement ID.
- Catalogue of scenarios and their status: `.claude/skills/adversarial-test/scenarios.md`.
- How to write one: `/adversarial-test` skill.

Run: `pnpm test:adversarial`.
