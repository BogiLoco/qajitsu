---
name: qajitsu-architecture
description: Background knowledge of how QAJitsu works - pipeline stages, statuses, run workspace layout, packages, adapters, evidence and the trust model. Load when designing, planning or reviewing any change to QAJitsu itself.
user-invocable: false
---

# QAJitsu architecture in one page

Sources, in order of authority:

- Requirements (what must be true): `docs/requirements/` — ids `REQ-<AREA>-NN`, acceptance criteria `REQ-X-NN/ACk`, index in `docs/requirements/README.md`.
- Build order and "done when" per stage: `docs/roadmap.md`; current position: `docs/STATUS.md`.
- Architecture map: `docs/architecture/overview.md`. Decisions: `docs/adr/`. Invariants: `INV-1`..`INV-12`.
- Background rationale (Polish): `docs/plan.md`; the catalogue wins on conflicts.

When work touches an area, read that area's requirement file first (CTX context, PLAN plan, ENV environment, CFG config-secrets, WS workspace, EXEC execution, VER verification, EVD evidence, PUB publishing, LLM models, OBS observability, CI ci-cd, GEN generic, NFR non-functional).

## Pipeline (orchestrated by deterministic code in `packages/core`)

| #   | Stage                                                   | Who                                      | Output in run workspace                   |
| --- | ------------------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| 1   | Fetch context: ticket, linked PR/MR, repos at SHA       | code                                     | `ticket/`, `repos/` (+ diffs)             |
| 2   | Analyse change                                          | Analyst agent                            | `analysis.json`                           |
| 3   | Plan                                                    | Planner agent                            | `plan/plan.vN.yaml`, `plan.vN.md`         |
| 4   | Human review loop                                       | user                                     | revisions until approved                  |
| 5   | Freeze plan                                             | code                                     | `plan/plan.approved.yaml` + SHA-256       |
| 6   | Environment: `--env <name/url>` or `--build`            | code (EnvProvider)                       | `env/`, `logs/`                           |
| 7   | Author executable specs                                 | Author agent (+ MCP recon)               | `specs/`                                  |
| 8   | Static checks: tsc, lint, plan coverage, assertion lock | code                                     | `checks.json`                             |
| 9   | Execute                                                 | runners (Playwright, WebdriverIO+Appium) | `results/`, `evidence/` + `manifest.json` |
| 10  | Heal (selectors/waits only, max 2)                      | Healer agent                             | patched specs, AST-diff verified          |
| 11  | Audit                                                   | Auditor agent (fresh context, read-only) | `audit.json`                              |
| 12  | Gates                                                   | code (`packages/verifier`)               | `gates.json`                              |
| 13  | Report and publish                                      | code (+ summary text validated)          | `report/`, Jira comment, attachments      |
| 14  | Cleanup per retention                                   | code                                     | —                                         |

Every stage writes a checkpoint to `run.json`; `qajitsu resume` continues from the last one.

## Statuses (closed union, exhaustively switched)

`PASSED` all `verify()` passed on first attempt with evidence for every step ·
`FAILED` at least one `verify()` failed; expected and actual recorded ·
`FLAKY` failed, then passed on retry ·
`BLOCKED` could not execute (env, data, spec failed static checks) ·
`NOT_RUN` in plan but not executed ·
`NEEDS_REVIEW` runner said PASSED but auditor or a gate found an inconsistency.
Only code computes statuses. The auditor can only downgrade PASSED to NEEDS_REVIEW.

## Run workspace

`<root>/<TICKET>/<RUN-ID>/` with RUN-ID `YYYYMMDD-HHMM-xxxx`. Docker resources carry labels `qajitsu.ticket` and `qajitsu.run`; compose project name `qj-<ticket>-<suffix>`. `.env` files are 0600 and always deleted after a run.

## Packages and dependency direction

`cli → core → (interfaces only)`; `adapters/*`, `agents`, `models`, `guard`, `steps`, `verifier`, `report` implement or consume interfaces from `core`. Core never imports adapters. Only `models` imports provider SDKs.

## Adapter interfaces (in `@qajitsu/core`)

`TicketSource`, `CodeHost` (GitHub, GitLab), `ModelProvider` (AI SDK providers, Ollama, OpenAI-compatible/LiteLLM), `EnvProvider` (remote, compose, device farm), `SecretProvider`, `AttemptExecutor` (the runner seam: one attempt of one case; api, web and mobile through the sandbox executor, ADR-0005), `EvidenceStore`, `Publisher` (Jira comment, Xray, Zephyr).

## Agent loop

Own loop on Vercel AI SDK. Each stage call: allowed tools, max turns, token budget, Zod-validated output with up to 3 repair attempts, then hard failure. The guard wraps every tool call (`preToolUse` deny rules, `postToolUse` journal to `journal/events.jsonl`). Model per role from `models.roles` in project config; auditor should use a different model than author.

## Evidence

API: request/response JSON per call (masked), cURL, timings. Web: screenshot per step, video and trace on failure, console, HAR. Mobile: screenshot per step, screen recording on failure, logcat/syslog. All files listed with SHA-256 in `evidence/manifest.json`.

## Plan schema essentials

Case: `id`, `title`, `type` (api|web|mobile), `priority`, `source` (ac | quote verified verbatim against ticket | diff file), `preconditions`, `steps[]` with `id`, `action`, `expect`, and `evidence[]`. Plus `open_questions`, `out_of_scope`.
