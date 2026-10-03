---
name: demo-bug
description: Add a deliberately seeded bug to examples/demo-shop together with the fictional ticket, the expected FAILED result in the regression suite, and a bench case. Use to grow QAJitsu's self-test and model evaluation set.
argument-hint: "[bug description, e.g. 'cart total ignores quantity']"
---

# /demo-bug $ARGUMENTS

demo-shop is the app QAJitsu tests itself on. Each seeded bug proves the framework can turn a real defect into FAILED.

1. **Ticket**: add a fictional Jira ticket fixture `examples/demo-shop/tickets/DEMO-<n>.json` describing the intended behaviour (acceptance criteria included). It must read like a normal story, not mention the bug.
2. **Bug**: introduce the defect behind a flag in demo-shop (`BUGS=<id>` env var), so the clean build stays correct. Keep it small and realistic: off-by-one, wrong status code, missing validation, stale UI state, wrong rounding.
3. **Register** it in `examples/demo-shop/BUGS.md`: id, type (api/web/mobile), affected endpoint or screen, ticket, expected failing case.
4. **Regression expectation**: add to `tests/e2e/expectations.ts` that running the pipeline on `DEMO-<n>` with the flag yields FAILED for the expected case, and PASSED without the flag. Use the scripted model so the e2e test stays deterministic.
5. **Bench case**: add the ticket to `bench/cases.yaml` so real models are scored on detecting it (detection rate, false failures).
6. Run `pnpm test:e2e -- DEMO-<n>` (delegate to the `e2e-runner` agent on failure), then `/verify`.

Never seed bugs into anything outside `examples/demo-shop`.
