---
name: qa-run
description: Run the approved QAJitsu test plan of a Jira ticket and report the results computed by QAJitsu. Use when the user asks to run, execute or retest a ticket (e.g. "/qa-run SHOP-482", "odpal testy DEMO-1 na buildzie").
---

# /qa-run <TICKET> [--env <profile> | --build]

Execute the approved plan of a ticket with the `qajitsu` CLI and report what QAJitsu computed. Statuses come
from the test runner and QAJitsu's checks; **you never change, guess or round them**.

Command: `qajitsu` (or `qj`), in the project folder that contains `.qa/`.

## Steps

1. Make sure the plan is approved: `qajitsu runs <TICKET>` shows the latest run and its stage. If it is not
   approved, offer `/qa-plan <TICKET>` and stop.
2. Choose the environment with the user, if they did not say:
   - a deployed environment: `qajitsu run <TICKET> --env <profile>` (profiles are files in `.qa/envs/`);
   - built from the change itself: `qajitsu run <TICKET> --build` (Docker Compose or processes, see
     `qajitsu env check`). With `--build`, `--set <service>.<VAR>=<value>` switches overridable variables.
3. Run it and wait; it can take minutes (mobile cases start an emulator).
4. Show the matrix QAJitsu printed (cases and statuses) and the exit code meaning:
   `0` all passed, `1` something FAILED, `2` blocked, flaky, not run or needs review, `3` setup or framework error.
5. If anything is FAILED, BLOCKED or NEEDS_REVIEW, offer `/qa-evidence <TICKET>`.
6. Publishing to Jira is the user's call: `qajitsu publish <TICKET>` shows a preview and asks for confirmation
   in the terminal; tell the user to run it themselves when they are ready.

## Rules

- Quote statuses exactly. NEEDS_REVIEW means a person must look; it is not a pass.
- Never edit specs, results, evidence or reports to make a run pass. A bug in the product is a FAILED test.
- Do not rerun again and again hoping for PASSED; FLAKY is a finding, not noise.
- Never print secrets; errors from QAJitsu are already masked.
