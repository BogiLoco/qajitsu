# Architecture overview

This page is the short English map of the system. The rationale and alternatives considered are in
[`docs/plan.md`](../plan.md) (Polish) and the [ADRs](../adr/); what must be built is in [requirements](../requirements/README.md).

## The core idea

**Agents plan and write tests; deterministic code executes and judges.** LLMs are good at reading a ticket and a diff
and proposing what to test. They are not trusted with anything that decides whether a test passed. That split is
enforced by twelve [invariants](../../.claude/rules/architecture-invariants.md) (`INV-1`..`INV-12`) and by tests that play
a lying agent (`tests/adversarial`).

## End-to-end flow

```text
Phase A: planning (agents + human)               Phase B: execution (code + runners)
1. Context: ticket, PRs/MRs, diff, repos          6. Environment: --env <profile|URL> or --build
2. Analysis: api / web / mobile, risks            7. Executable specs from the plan (tsc, coverage, assertion lock)
3. Plan plan.vN.yaml (+ .md)                      8. Execution and evidence (status from the runner)
4. Human review  <-- revisions -->                9. Verification: gates + auditor (may only downgrade)
5. Approved plan frozen (SHA-256)  ------------>  10. Matrix, report, Jira comment, cleanup
```

Requirements: phase A is `REQ-CTX-*`, `REQ-PLAN-*`; phase B is `REQ-ENV-*`, `REQ-EXEC-*`, `REQ-VER-*`, `REQ-EVD-*`, `REQ-PUB-*`, `REQ-WS-*`.

## Components

```text
CLI qajitsu / qj  (later: CI action, Claude Code plugin)
  -> Orchestrator (code, not an agent): state machine, checkpoints in run.json          INV-9
       -> Agent loop on Vercel AI SDK + guard around every tool call                     ADR-0003, INV-2
            roles: analyst, planner, author, healer, auditor
       -> Deterministic code: workspace, env, static checks, runners, steps, gates, report
            -> Adapters behind interfaces: Jira, GitHub, GitLab, env, secrets, runners, evidence, publish   INV-12
```

| Package              | Responsibility                                                                                           | Key requirements                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| `@qajitsu/core`      | Interfaces, Zod schemas, project config, statuses, errors, ids; later the orchestrator and run workspace | REQ-GEN-01, REQ-GEN-02, REQ-VER-01, REQ-WS-01            |
| `@qajitsu/guard`     | Default-deny tool policy, write bans, URL allowlist, tool-call journal                                   | REQ-VER-03, REQ-VER-04, REQ-ENV-01                       |
| `@qajitsu/steps`     | `step()` / `verify()` used by generated tests; masking; evidence recording                               | REQ-EXEC-02, REQ-CFG-06                                  |
| `@qajitsu/verifier`  | Status computation, publish gates, assertion lock, plan coverage, secret scan                            | REQ-VER-02, REQ-VER-07, REQ-EXEC-03                      |
| `@qajitsu/report`    | Matrix (md/csv/xlsx), report.html, Jira ADF comment                                                      | REQ-EVD-04, REQ-EVD-05, REQ-PUB-01                       |
| `@qajitsu/models`    | Model references, role mapping, provider adapters, capability probes                                     | REQ-LLM-01..04                                           |
| `@qajitsu/agents`    | Agent loop, role definitions, prompts, structured output with repair                                     | REQ-PLAN-*, REQ-EXEC-01, REQ-EXEC-09, REQ-VER-06         |
| `@qajitsu/cli`       | `qajitsu` / `qj` commands and exit codes                                                                 | REQ-GEN-05, REQ-CI-04                                    |
| `@qajitsu/adapter-*` | One package per integration, selected by `type` in config                                                | see [adapters README](../../packages/adapters/README.md) |

Dependency direction: `cli → core orchestration → (agents, verifier, report, guard, steps) → core interfaces ← adapters`.
Core never imports an adapter (INV-12); only `models` imports provider SDKs (INV-11).

## Agents

| Role    | Input                                   | Output              | Tools                                                       |
| ------- | --------------------------------------- | ------------------- | ----------------------------------------------------------- |
| analyst | ticket, diff, OpenAPI, `.qa/knowledge/` | `analysis.json`     | read files; Jira/Git read-only                              |
| planner | analysis, existing tests                | `plan/plan.vN.yaml` | read; write only under `plan/` except the approved file     |
| author  | approved plan, test repo, helpers       | `specs/*`           | read; write `specs/`; Playwright/Appium MCP on the test env |
| healer  | failing spec, failure evidence          | patched spec        | like author; assertion-lock diff on every change            |
| auditor | plan, results, evidence images          | `audit.json`        | read-only; may only downgrade PASSED to NEEDS_REVIEW        |

Each stage is one agent-loop call with an allowlist of tools, a turn limit and a token budget; output is validated with
Zod and repaired up to three times, then the stage fails (REQ-LLM-04). Models are assigned per role (REQ-LLM-02).

## Run workspace

```text
.qa-runs/<TICKET>/<RUN_ID>/          RUN_ID = 20261003-1425-k3f9 (REQ-WS-01)
  run.json                           state machine checkpoint (code only)
  ticket/                            ticket snapshot, never refetched during the run (REQ-CTX-01)
  repos/                             repositories at the change's commit, diffs (REQ-CTX-04)
  analysis.json                      analyst output
  plan/                              plan.v1.yaml, plan.v1.md, ..., plan.approved.yaml (+ hash)
  specs/                             generated tests (author, healer)
  results/                           runner output only            (agents denied, INV-2)
  evidence/  manifest.json           screenshots, video, req/resp  (agents denied, INV-7)
  journal/events.jsonl               every tool call, step, human action (REQ-OBS-01)
  logs/                              environment and service logs
  report/                            matrix.md, matrix.csv, report.html, jira-comment.json
  env/                               generated .env files          (never read by agents)
```

## Statuses and exit codes

`PASSED`, `FAILED`, `FLAKY`, `BLOCKED`, `NOT_RUN`, `NEEDS_REVIEW` (REQ-VER-01). Unknown never becomes PASSED: missing
evidence, a crashed runner or a broken environment give `BLOCKED`. Exit codes: `0` all passed, `1` any failed,
`2` otherwise not all passed, `3` framework or configuration error (REQ-CI-04).

## Where to go next

- Decisions: [ADR-0001](../adr/0001-typescript-monorepo.md) TypeScript monorepo, [ADR-0002](../adr/0002-verdict-from-runner.md) verdict from runner,
  [ADR-0003](../adr/0003-provider-agnostic-agent-loop.md) provider-agnostic agent loop.
- Build order: [roadmap](../roadmap.md).
- Terms: [glossary](../glossary.md).
