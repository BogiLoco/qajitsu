# 0009. External agent mode: an agent outside QAJitsu writes drafts, QAJitsu checks and executes

- Status: Proposed (to be reviewed: agreed as an idea on 2026-10-16, to be thought through before acceptance)
- Date: 2026-10-16
- Related: REQ-GEN-07, REQ-GEN-04, ADR-0003, ADR-0002, INV-1, INV-2, INV-3, INV-4

## Context

ADR-0003 gives QAJitsu its own agent loop: every tool call of its agents goes through the guard (write bans, URL
allowlist, journal). Testers who work in Claude Code want its subagents, each on a model they choose and on their own
subscription, to do the analyst's, planner's, author's and healer's work. Anthropic does not allow third-party products
to offer claude.ai login or subscription limits, so QAJitsu must not call Claude Code itself (REQ-LLM-08 stays
proposed); the person runs Claude Code and QAJitsu only receives files.

## Decision

- QAJitsu gets a mode without models: drafts come from files (`qj plan --draft`, `qj run --no-author`,
  `qj heal --draft`). Every draft passes exactly the checks the own agents' output passes; nothing is trusted because
  of who wrote it.
- What decides a result does not move: execution, statuses, gates, approval hashing and reports stay in QAJitsu's
  code (ADR-0002, invariants 1, 3, 4, 6).
- The guard cannot see Claude Code's tools. Instead: plugin hooks deny writes to protected paths and the commands
  that only a person may run; `qj approve` refuses inside an agent session; hashes (approved plan, evidence manifest,
  check records, journal chain) and publish gates detect any change after the fact. This is defence in depth, not the
  guard's hard boundary, and the run records that an external agent wrote its drafts.
- Approval stays human. An AI approver is out of scope; it would need its own ADR because the approved plan is where
  expected values come from.

## Consequences

- Plans and specs can be written by strong models on a subscription without QAJitsu holding any credentials.
- The protection of results relies on hooks and detection rather than the guard while the session runs; reports show
  that the run used an external agent.
- QAJitsu's own agents and the external mode share all checks, so a weakness found in one is fixed for both.
