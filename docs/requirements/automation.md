# Automation suite and failure triage (AUTO)

Tests that proved themselves in agent-driven runs are promoted into a suite that runs without a model (REQ-PUB-08, REQ-EXEC-17), which is much cheaper. When such a test fails, triage reproduces the failure and says whether it looks like a product bug, a test problem or an environment problem. Details still to be refined.

### REQ-AUTO-01 · Automation candidates ranked by value

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-PUB-08, REQ-EXEC-17, REQ-EXEC-08, REQ-PLAN-06
- Note: TO BE REVIEWED: the full text also asked that the automated suite run without QAJitsu as a plain Playwright or WebdriverIO project (no lock-in); promoted packs use `@qajitsu/steps` today, so that would be a design change worth its own decision.

`qj promote` (REQ-PUB-08) already turns PASSED cases into a pull request to the tests repository and `qj regression` (REQ-EXEC-17) runs them without a model. This adds which cases to promote.

**Acceptance criteria**

- [ ] AC1: After a run, cases that passed with stable steps (no healing in their last runs, no FLAKY history) are offered as automation candidates.
- [ ] AC2: Candidates are ranked by expected value: business priority, how often the area changes, and how expensive an agent run of the case is.
- [ ] AC3: The choice per case between the promoted suite and the agentic regression is the project's and is recorded.

### REQ-AUTO-02 · Failure triage by reproduction

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-EXEC-17, REQ-EXEC-08, REQ-VER-11, REQ-VER-12, INV-1

Failure hints (REQ-VER-12) classify a FAILED case from its evidence; this classifies it by running it again in several ways.

**Acceptance criteria**

- [ ] AC1: A failing case of the promoted suite triggers triage automatically.
- [ ] AC2: Triage steps: run again, run again on a fresh environment, run the same case agent-driven from the plan, and where possible run it against the last commit where it passed.
- [ ] AC3: The outcome is a classification with evidence: PRODUCT_BUG, TEST_ISSUE, ENVIRONMENT_ISSUE, FLAKY or UNKNOWN; the reasons cite the reproduction runs.
- [ ] AC4: The classification is advisory and shown separately; the failing run stays FAILED and triage never changes it.
- [ ] AC5: PRODUCT_BUG proposes a bug ticket with steps, evidence and a reproduction script (REQ-AUTO-04); TEST_ISSUE proposes a fix as a pull request (selectors and waits only, REQ-EXEC-09); nothing is filed or merged without approval unless a project policy allows it.
- [ ] AC6: Triage has a time and cost budget; when it is used up the result is UNKNOWN.

### REQ-AUTO-03 · Suite maintenance

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-EXEC-17, REQ-EXEC-09, REQ-SKILL-07

**Acceptance criteria**

- [ ] AC1: Tests that keep needing healing or are often FLAKY are flagged and may be moved back to the agentic regression.
- [ ] AC2: Tests not linked to any current feature or ticket area for a configurable period are proposed for removal.
- [ ] AC3: A maintenance report lists flaky, slow, healed and unused tests with their cost.

### REQ-AUTO-04 · Portable bug reproduction scripts

- Status: proposed
- Priority: should
- Stage: 10
- Related: REQ-AUTO-02, REQ-PUB-07, REQ-CFG-07, REQ-ENV-01

**Acceptance criteria**

- [ ] AC1: For a confirmed product bug a reproduction script is generated in the project's chosen language (shell, Python or JavaScript).
- [ ] AC2: The script does not depend on one environment: base URL, test account aliases and other settings come from parameters or environment variables; it holds no secrets, hosts or data of a specific environment.
- [ ] AC3: The script is checked before it is attached: it must fail on the affected environment, and pass on a fixed version when there is one.
- [ ] AC4: It prints REPRODUCED or NOT REPRODUCED and exits with a matching code.
- [ ] AC5: It runs only against environments on the allowlist and is attached to the bug ticket (REQ-PUB-07) with its checksum.
