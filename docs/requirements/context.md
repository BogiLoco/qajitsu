# Context: ticket, code and repositories (CTX)

What QAJitsu collects before any agent runs: the ticket, the change that implements it, the repositories at the right version, and project knowledge.

### REQ-CTX-01 · Jira ticket as the input

- Status: accepted
- Priority: must
- Stage: 1
- Related: REQ-GEN-05, REQ-PUB-03

A run starts from a Jira ticket key (`qajitsu test SHOP-482`). QAJitsu fetches the ticket and stores a snapshot in the run workspace, so planning and auditing work from the same data even if the ticket changes later. The key is validated before it is used in paths, branch searches or labels.

**Acceptance criteria**

- [ ] AC1: Fetches summary, description, acceptance criteria (from the description or a configured custom field), comments, linked issues and attachment metadata.
- [ ] AC2: Stores the snapshot under `ticket/` in the run workspace and never refetches it during the run.
- [ ] AC3: Rejects malformed keys before any network call (pattern `PROJECT-123`).
- [ ] AC4: Works with Jira Cloud; Jira Data Center support is tracked separately (REQ-PUB-03).
- [ ] AC5: A ticket that cannot be fetched ends the run with a configuration/framework error (exit code 3), not with test statuses.

### REQ-CTX-02 · GitHub and GitLab support

- Status: accepted
- Priority: must
- Stage: 1
- Related: REQ-GEN-02, ADR-0001

Both GitHub and GitLab are supported from the first version, cloud and self-hosted, behind one `CodeHost` interface. A project may mix them, e.g. backend on GitLab and frontend on GitHub.

**Acceptance criteria**

- [ ] AC1: `CodeHost` implementations exist for GitHub (incl. GitHub Enterprise Server) and GitLab (incl. self-managed) via `base_url`.
- [ ] AC2: Both pass the same shared contract test suite.
- [ ] AC3: Authentication: GitHub fine-grained token or GitHub App; GitLab project/group access token with `read_api` and `read_repository`. Tokens come from the SecretProvider.
- [ ] AC4: One project configuration can reference repositories on both hosts.

### REQ-CTX-03 · Change discovery for a ticket

- Status: accepted
- Priority: must
- Stage: 1
- Related: REQ-CTX-02, REQ-CTX-04

QAJitsu finds which PRs/MRs and branches implement the ticket, in a fixed order of strategies, and records which strategy matched.

**Acceptance criteria**

- [ ] AC1: Strategy 1: links from the Jira development panel (GitHub for Jira / GitLab for Jira integrations).
- [ ] AC2: Strategy 2: ticket key in PR/MR titles and branch names across repositories declared in `.qa/qa.project.yaml`.
- [ ] AC3: Strategy 3: manual `--pr <url>`, `--mr <url>` or `--ref <branch|tag|sha>` overrides discovery.
- [ ] AC4: A change spanning several repositories yields one entry per repository.
- [ ] AC5: No change found: the user is asked (interactive) or the run stops with a clear message (CI); it never silently tests the default branch.

### REQ-CTX-04 · Repositories always fetched at the change's version

- Status: accepted
- Priority: must
- Stage: 1
- Related: REQ-CTX-05, REQ-ENV-03, REQ-WS-01

Repositories with the change are fetched on every run, also when tests run against an existing environment, so agents analyse real code instead of guessing from the ticket.

**Acceptance criteria**

- [ ] AC1: A bare mirror per repository is kept in a cache (`~/.qa-cache/git`) and updated incrementally.
- [ ] AC2: Each run gets a `git worktree` per repository at the exact SHA under `repos/`.
- [ ] AC3: The SHA of every repository is recorded in `run.json` and in the Jira report.
- [ ] AC4: `--build` uses exactly these worktrees, so the tested code is the analysed code.

### REQ-CTX-05 · Code analysis context for agents

- Status: accepted
- Priority: must
- Stage: 2
- Related: REQ-PLAN-01, REQ-PLAN-03, REQ-NFR-05

Agents receive enough of the change to plan precisely without flooding their context.

**Acceptance criteria**

- [ ] AC1: Full read-only access to the worktrees through file, search and list tools.
- [ ] AC2: Diff against the PR/MR target branch and the list of changed files, excluding generated files and lock files.
- [ ] AC3: PR/MR description and review comments are included as context.
- [ ] AC4: Related files are surfaced: unit tests in the change, endpoint definitions, migrations, translations.
- [ ] AC5: Large diffs are summarised with a file list; the agent searches the rest on demand.
- [ ] AC6: All of this content is framed as untrusted data in prompts (prompt-injection defence).

### REQ-CTX-06 · Test repository awareness

- Status: accepted
- Priority: should
- Stage: 3
- Related: REQ-EXEC-01

QAJitsu reads the project's existing test repository to follow its conventions and avoid duplicating cases.

**Acceptance criteria**

- [ ] AC1: The tests repository is declared in config (`repos.<alias>.role: tests`) and checked out like any other repo.
- [ ] AC2: The planner lists existing cases that already cover parts of the ticket.
- [ ] AC3: The author reuses existing helpers and page objects when present.
- [ ] AC4: Optionally (opt-in), new approved cases are proposed as a PR/MR to the tests repository.

### REQ-CTX-07 · Project knowledge for agents

- Status: accepted
- Priority: should
- Stage: 2
- Related: REQ-GEN-01

Teams can give agents domain knowledge that is not in the code.

**Acceptance criteria**

- [ ] AC1: Markdown files in `.qa/knowledge/` (glossary, conventions, test account descriptions by alias) are provided to analyst and planner.
- [ ] AC2: Knowledge files never contain secrets; the secret scan runs over them.
