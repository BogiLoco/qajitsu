# Context: ticket, code and repositories (CTX)

What QAJitsu collects before any agent runs: the ticket, the change that implements it, the repositories at the right version, and project knowledge.

### REQ-CTX-01 · Jira ticket as the input

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-GEN-05, REQ-PUB-03

A run starts from a Jira ticket key (`qajitsu test SHOP-482`). QAJitsu fetches the ticket and stores a snapshot in the run workspace, so planning and auditing work from the same data even if the ticket changes later. The key is validated before it is used in paths, branch searches or labels.

**Acceptance criteria**

- [x] AC1: Fetches summary, description, acceptance criteria (from the description or a configured custom field), comments, linked issues and attachment metadata.
- [x] AC2: Stores the snapshot under `ticket/` in the run workspace and never refetches it during the run.
- [x] AC3: Rejects malformed keys before any network call (pattern `PROJECT-123`).
- [x] AC4: Works with Jira Cloud; Jira Data Center support is tracked separately (REQ-PUB-03).
- [x] AC5: A ticket that cannot be fetched ends the run with a configuration/framework error (exit code 3), not with test statuses.

### REQ-CTX-02 · GitHub and GitLab support

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-GEN-02, ADR-0001

Both GitHub and GitLab are supported from the first version, cloud and self-hosted, behind one `CodeHost` interface. A project may mix them, e.g. backend on GitLab and frontend on GitHub.

**Acceptance criteria**

- [x] AC1: `CodeHost` implementations exist for GitHub (incl. GitHub Enterprise Server) and GitLab (incl. self-managed) via `base_url`.
- [x] AC2: Both pass the same shared contract test suite.
- [x] AC3: Authentication: GitHub fine-grained token or GitHub App; GitLab project/group access token with `read_api` and `read_repository`. Tokens come from the SecretProvider.
- [x] AC4: One project configuration can reference repositories on both hosts.

### REQ-CTX-03 · Change discovery for a ticket

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-CTX-02, REQ-CTX-04

QAJitsu finds which PRs/MRs and branches implement the ticket, in a fixed order of strategies, and records which strategy matched.

**Acceptance criteria**

- [x] AC1: Strategy 1: links from the Jira development panel (GitHub for Jira / GitLab for Jira integrations).
- [x] AC2: Strategy 2: ticket key in PR/MR titles and branch names across repositories declared in `.qa/qa.project.yaml`.
- [x] AC3: Strategy 3: manual `--pr <url>`, `--mr <url>` or `--ref <branch|tag|sha>` overrides discovery.
- [x] AC4: A change spanning several repositories yields one entry per repository.
- [x] AC5: No change found: the user is asked (interactive) or the run stops with a clear message (CI); it never silently tests the default branch.

### REQ-CTX-04 · Repositories always fetched at the change's version

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-CTX-05, REQ-ENV-03, REQ-WS-01, REQ-PRJ-08

Repositories with the change are fetched on every run, also when tests run against an existing environment, so agents analyse real code instead of guessing from the ticket.

**Acceptance criteria**

- [x] AC1: A bare mirror per repository is kept in the project's cache (`<project-home>/cache/git/`, REQ-PRJ-08) and updated incrementally.
- [x] AC2: Each run gets a `git worktree` per repository at the exact SHA under `repos/`.
- [x] AC3: The SHA of every repository is recorded in `run.json` and in the Jira report.
- [x] AC4: `--build` uses exactly these worktrees, so the tested code is the analysed code.

### REQ-CTX-05 · Code analysis context for agents

- Status: implemented
- Priority: must
- Stage: 2
- Related: REQ-PLAN-01, REQ-PLAN-03, REQ-NFR-05

Agents receive enough of the change to plan precisely without flooding their context.

**Acceptance criteria**

- [x] AC1: Full read-only access to the worktrees through file, search and list tools.
- [x] AC2: Diff against the PR/MR target branch and the list of changed files, excluding generated files and lock files.
- [x] AC3: PR/MR description and review comments are included as context.
- [x] AC4: Related files are surfaced: unit tests in the change, endpoint definitions, migrations, translations.
- [x] AC5: Large diffs are summarised with a file list; the agent searches the rest on demand.
- [x] AC6: All of this content is framed as untrusted data in prompts (prompt-injection defence).

### REQ-CTX-06 · Test repository awareness

- Status: implemented
- Priority: should
- Stage: 3
- Related: REQ-EXEC-01

QAJitsu reads the project's existing test repository to follow its conventions and avoid duplicating cases.

**Acceptance criteria**

- [x] AC1: The tests repository is declared in config (`repos.<alias>.role: tests`) and checked out like any other repo.
- [x] AC2: The planner lists existing cases that already cover parts of the ticket.
- [x] AC3: The author reuses existing helpers and page objects when present: their selectors and flows, since specs run sandboxed and cannot import them (ADR-0004).
- [x] AC4: Optionally (opt-in), new approved cases are proposed as a PR/MR to the tests repository (see REQ-PUB-08).

### REQ-CTX-07 · Project knowledge for agents

- Status: implemented
- Priority: should
- Stage: 2
- Related: REQ-GEN-01, REQ-KNOW-01

Teams can give agents domain knowledge that is not in the code.

**Acceptance criteria**

- [x] AC1: Markdown files in `.qa/knowledge/` (glossary, conventions, test account descriptions by alias) are provided to analyst and planner.
- [x] AC2: Knowledge files never contain secrets; the secret scan runs over them.

### REQ-CTX-08 · Import existing manual test cases

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-CTX-01, REQ-PLAN-03, REQ-PUB-05

**Acceptance criteria**

- [ ] AC1: Manual test cases linked to the ticket can be read from Xray, Zephyr Scale, TestRail or an Excel/CSV file.
- [ ] AC2: They are given to the planner as an additional source; plan cases based on them cite the imported case id.
- [ ] AC3: Imported text is treated as untrusted data and never as instructions.
- [ ] AC4: An unreachable source is reported and planning continues without it.
