---
name: feature-plan
description: Produce an implementation plan for a QAJitsu feature or roadmap stage using the planner agent, before writing code.
argument-hint: "[feature or roadmap stage, e.g. 'stage 3: API runner']"
context: fork
agent: planner
background: false
---

Plan the following QAJitsu work: $ARGUMENTS

Follow your planner instructions and output format exactly. Before planning read:

- the requirements the request maps to in `docs/requirements/` (use `node scripts/requirements.mjs list --stage N` for a stage),
- `docs/roadmap.md` for the stage and its "done when" criterion (copy it as the goal),
- `.claude/rules/architecture-invariants.md`, `docs/architecture/overview.md` and the ADRs in `docs/adr/`.

Every step of the plan names the acceptance criteria (`REQ-X-NN/ACk`) it covers. Work not covered by a requirement gets a proposed requirement first.

End the plan with the first `/tdd` command the main conversation should run.
