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
- [x] AC5: Without any tests repository in the run, a claim of existing coverage cannot be checked: code turns it into an open question for the person (which test, which criteria, that no case was written) instead of refusing the plan, so the plan is kept and no criterion goes untested without a decision.

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

- Status: implemented
- Priority: could
- Stage: later
- Related: REQ-CTX-01, REQ-PLAN-03, REQ-PUB-05

**Acceptance criteria**

- [x] AC1: Manual test cases linked to the ticket can be read from Xray, Zephyr Scale, TestRail or an Excel/CSV file.
- [x] AC2: They are given to the planner as an additional source; plan cases based on them cite the imported case id.
- [x] AC3: Imported text is treated as untrusted data and never as instructions.
- [x] AC4: An unreachable source is reported and planning continues without it.

### REQ-CTX-09 · Tickets from sources other than Jira

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-CTX-01, REQ-CTX-08, REQ-GEN-02

Jira stays the default source of the ticket; a ticket can also come from other tools and files through a ticket source adapter. Importing existing test cases is REQ-CTX-08.

**Acceptance criteria**

- [ ] AC1: Jira is the default source; no configuration is needed to keep today's behaviour.
- [ ] AC2: Adapters for Confluence pages, Notion pages and local Markdown and JSON files.
- [ ] AC3: Every source maps to one normalised ticket (title, description, acceptance criteria, attachments, links); missing fields are reported, never invented.
- [ ] AC4: An unreachable or unparseable source stops the run before planning with a clear error; nothing is planned from partial input without confirmation.
- [ ] AC5: Source content is treated as untrusted data in prompts.

### REQ-CTX-10 · Code access levels

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-CTX-04, REQ-CTX-05, REQ-EXEC-23, REQ-VER-11, REQ-VER-14, INV-11
- Note: accepted by the owner on 2026-10-21 and implemented. TO BE REVIEWED: with `metadata` the code hosts return the changed file names together with the diff, so the diff is read once in memory to list the names and dropped; nothing of it is stored, cached or sent to a model. The tests repository (`role: tests`) is fetched in every mode.

Some companies will not share source code. The project chooses how much of the code QAJitsu may read.

**Acceptance criteria**

- [x] AC1: `code.access` in the project config: `full` (repositories at the change commit), `metadata` (PR/MR title, description and list of changed files, no file contents) or `none` (black-box).
- [x] AC2: With `metadata` or `none`, no repository content is fetched, cached or sent to any model; a test on the fetch layer proves it.
- [x] AC3: Features that need code (diff coverage, fix verification REQ-VER-11, mutation check REQ-VER-14) are switched off with a clear message instead of failing silently.
- [x] AC4: The access level is recorded in `run.json` and shown in the report header.

### REQ-CTX-11 · Context fragments

- Status: in-progress
- Priority: must
- Stage: later
- Related: REQ-CTX-05, REQ-CTX-07, REQ-VER-16, INV-8, INV-11, ADR-0014

Everything a model sees is assembled by code from fragments with known origin, trust and size, instead of strings
concatenated in each role.

**Acceptance criteria**

- [x] AC1: Every piece of model input is a fragment with a kind (role instructions, project rules, ticket, plan, diff, file, knowledge, tool result, log, evidence, lesson, skill), a source (file path, ticket key, tool call id, URL), a trust level (`trusted`: QAJitsu's instructions and the approved plan; `untrusted`: tickets, code, pages, logs, tool output), a priority, a `pinned` flag, its token count and its SHA-256. The schema lives in `@qajitsu/core` and is validated with Zod.
- [ ] AC2: Pinned fragments (the approved plan, the step's expectations, the auditor's rubric) are never dropped, trimmed, summarised or compacted; a context that cannot fit them stops the call with the reason, never sends it without them.
- [ ] AC3: Every agent role builds its input only through fragments; a prompt string assembled outside the context manager is refused by a test over all roles.

### REQ-CTX-12 · Context pipeline with recorded reductions

- Status: in-progress
- Priority: must
- Stage: later
- Related: REQ-CTX-11, REQ-LLM-12, REQ-LLM-15, REQ-VER-16, ADR-0014

**Acceptance criteria**

- [ ] AC1: The context manager in `@qajitsu/agents` runs in a fixed order: collect fragments from their sources, filter them by role (REQ-CTX-13), compute the budget (REQ-CTX-14), reduce, lay out, hand over to the provider's renderer in `@qajitsu/models`, record the snapshot (REQ-CTX-17). It knows no provider or model by name (INV-11).
- [x] AC2: The layout puts the stable part first (role instructions, project rules, skills, repository context) and the varying part last (ticket, results, the question), so provider caching applies (REQ-LLM-12/AC1).
- [ ] AC3: Every reduction (duplicate removed, fragment dropped, trimmed, summarised, replaced by a handle) is recorded with the fragment's hash, the reason and the tokens saved; nothing leaves the context silently.
- [ ] AC4: A fragment replaced by a handle can be read in full by the agent through a read-only tool (`read_context <handle>`); the reads are counted and recorded.
- [ ] AC5: Context starts small and grows on demand: material a role may need but does not always need (whole files, full logs, knowledge documents, older results) is offered as a catalogue of handles with a one-line description built by code (path, size, what it is), not as content; the agent reads what it needs with the tools.
- [ ] AC6: Fragments are selected by relevance to the task before any reduction: what the acceptance criteria, the plan's steps and the change name (files, endpoints, selectors, error messages) ranks first, computed by code from the fragments' metadata and text; the ranking and its reasons are part of the snapshot.

### REQ-CTX-13 · Role isolation of context

- Status: in-progress
- Priority: must
- Stage: later
- Related: REQ-CTX-11, REQ-VER-06, REQ-VER-09, INV-1, INV-5, ADR-0014

**Acceptance criteria**

- [x] AC1: Each role declares which fragment kinds and sources it may see; the declaration is code, reviewed like the guard, and the manager enforces it before the budget is computed.
- [ ] AC2: The auditor and any judge never receive the reasoning, drafts or tool transcripts of the analyst, planner, author or healer; they see the approved plan, runner results and evidence only.
- [ ] AC3: An adversarial suite shows that a fragment of a forbidden kind or source, also one smuggled inside another fragment's text or a tool result, never reaches a role that may not see it; the attempt is recorded.

### REQ-CTX-14 · Context budget and structure-aware reduction

- Status: accepted
- Priority: must
- Stage: later
- Related: REQ-CTX-12, REQ-LLM-12, REQ-LLM-15, REQ-EVD-09, ADR-0014

**Acceptance criteria**

- [ ] AC1: The budget of a call is the model's good working range (REQ-LLM-15) minus the space for the answer minus a safety margin; sources may get configured shares, and unused shares go to the others. A call that fits its budget is sent as it is: nothing is reduced ahead of need.
- [ ] AC2: Reductions are done by code first and in this order: duplicates removed; the least relevant non-pinned fragments moved into the catalogue as handles (REQ-CTX-12/AC5); trimming that keeps structure (a diff keeps changed hunks and signatures, a log keeps errors with a few lines around them, recorded traffic keeps method, URL, status and a short body), with the full text behind a handle.
- [ ] AC3: Reductions never touch pinned fragments and never change a number, an expected value or a quoted text of the ticket that a check relies on; a summary is untrusted data like its source.
- [ ] AC4: The budget, the reductions and the final input size are visible per call in the audit trail and in `qj logs`.
- [ ] AC5: A summary by a model is the last resort: only when the code reductions cannot reach the budget, only for non-pinned fragments, only when the role cannot read handles (no tool use in its model profile) or the project allows it, and always with a handle to the full text. Every summary is recorded with the model that wrote it.

### REQ-CTX-15 · Untrusted data blocks with a per-run boundary

- Status: in-progress
- Priority: must
- Stage: later
- Related: REQ-CTX-05, REQ-NFR-05, REQ-CTX-11, ADR-0014

`untrusted()` wraps data in a fixed tag and escapes closing tags; content that knows the tag can still try to imitate
its end.

**Acceptance criteria**

- [x] AC1: Untrusted fragments are always rendered in separate blocks that name their source, bounded by a marker drawn at random for the run (recorded in the snapshot); content containing the marker is neutralised, so a ticket or a page cannot close the block and continue as instructions.
- [x] AC2: Every role's instructions say that the content of data blocks is data, never instructions; the renderer picks the block form that suits the model (XML tags for Claude) without changing this meaning.
- [ ] AC3: An adversarial suite with injected instructions in a ticket, a diff, a page, a log and a tool result (including fake block ends) shows no change to the role's task, tools or output schema.

### REQ-CTX-16 · Compaction of long agent loops

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-CTX-12, REQ-CTX-14, REQ-EXEC-15, ADR-0014

**Acceptance criteria**

- [ ] AC1: An agent loop is compacted only when its next call would not fit the budget, never on a fixed number of turns; until then every tool result stays whole.
- [ ] AC2: Compaction replaces the oldest tool results that the loop no longer refers to by handles with a one-line description built by code (REQ-CTX-12/AC4); the last results and every result the latest turns cite stay whole. Summaries by a model follow REQ-CTX-14/AC5.
- [ ] AC3: Pinned fragments are never compacted; the compaction is recorded like every other reduction.

### REQ-CTX-17 · Deterministic context and its snapshot

- Status: in-progress
- Priority: must
- Stage: later
- Related: REQ-VER-16, REQ-VER-20, REQ-CTX-12, ADR-0014

**Acceptance criteria**

- [x] AC1: Fragments are ordered by fixed keys (layout section, priority, kind, source, hash); the stable part contains no timestamps or random values.
- [ ] AC2: Summaries are cached by the hash of their input and the summariser's model and version; repeating a run uses the same summary, never a new one.
- [x] AC3: Each call records a snapshot: the ordered fragment hashes, the reductions, the run's block marker, the renderer version and the model profile version, and one hash over them that goes into the journal and the audit trail.
- [ ] AC4: `qj reproduce` and `qj audit verify` rebuild the input of a recorded call from the snapshot and the run's files and report any difference by fragment.

### REQ-CTX-18 · Context metrics and context-policy benchmark

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-LLM-06, REQ-LLM-11, REQ-LLM-14, REQ-CTX-14

**Acceptance criteria**

- [ ] AC1: Per role and model the run records input tokens by source, reductions by kind, `read_context` calls and the cache hit rate; `qj metrics` exports them.
- [ ] AC2: `qj bench --context <policies>` runs the same tickets under different budgets and shares and reports plan quality, detection, cost and time per policy, so a project picks the cheapest policy that keeps quality.

### REQ-CTX-19 · Large changes analysed in parts

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-CTX-05, REQ-CTX-12, REQ-CTX-14, REQ-PLAN-01, REQ-LLM-15, ADR-0014

A change too large for one call, or for a small local model, is better split into tasks with a clean context each
than squeezed into one prompt.

**Acceptance criteria**

- [ ] AC1: When the change does not fit the analyst's budget, code splits it into parts (per repository, then per group of related files: a module, an endpoint with its handler and tests) and the analyst studies each part in its own call.
- [ ] AC2: Each part answers in a structured schema (endpoints, screens, risks, open questions, each with its sources); code merges the parts, removes duplicates and checks every source against the change, as for a single analysis.
- [ ] AC3: The planner works from the merged analysis and handles into the change, never from the raw diff of every part at once.
- [ ] AC4: The split, the parts and their snapshots are recorded; the same change splits the same way in every run.

### REQ-CTX-20 · Semantic signals for choosing context

- Status: accepted
- Priority: should
- Stage: later
- Related: REQ-CTX-12, REQ-CTX-14, REQ-CTX-17, REQ-CTX-19, REQ-KNOW-01, REQ-KNOW-08, INV-11, ADR-0014

The project's vector store and embedding model (REQ-KNOW-01, REQ-KNOW-08) help choose what a model sees; they never
decide alone and never summarise.

**Acceptance criteria**

- [ ] AC1: Relevance (REQ-CTX-12/AC6) may add the similarity of a fragment to the acceptance criteria and the plan's steps as a second signal next to the code's ranking; the code's ranking wins on ties, and a fragment ranked low only moves into the catalogue as a handle, it never leaves the context unreachable.
- [ ] AC2: The catalogue of a run (diff, logs, recorded traffic, tool results, evidence texts) can be searched by meaning through a read-only tool (`search_context "<question>"`) that returns handles with one-line descriptions, like `search_docs` for the knowledge base; results are untrusted data like their sources.
- [ ] AC3: Near-identical fragments (the same error in the logs of several attempts) are found by similarity above a threshold, confirmed by code on their text, and kept once; the others become handles.
- [ ] AC4: When a large change is split into parts (REQ-CTX-19), similarity may group related files that the code's links (imports, routes, tests) did not connect.
- [ ] AC5: Lessons of earlier runs of the same project (false FAILED reported with `qj feedback`, plan revisions a person asked for) are indexed and offered to the analyst and planner as low-priority, labelled fragments with their source run.
- [ ] AC6: Without an embedding model the manager works on code signals alone, with the same results otherwise; the embedding model and its version are part of the snapshot (REQ-CTX-17), and vectors are computed once per fragment hash and model and cached.
