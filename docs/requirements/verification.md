# Verification: fail stays fail (VER)

The layer that keeps results honest. Background: ADR-0002 and the architecture invariants (INV-1..INV-12) in `.claude/rules/architecture-invariants.md`.

### REQ-VER-01 · Status model

- Status: implemented
- Priority: must
- Stage: 1
- Related: INV-1, REQ-CI-04

**Acceptance criteria**

- [x] AC1: Exactly six statuses: PASSED, FAILED, FLAKY, BLOCKED, NOT_RUN, NEEDS_REVIEW, defined in `@qajitsu/core`.
- [x] AC2: Each status has a documented meaning in `docs/architecture/overview.md` and in user docs.
- [x] AC3: Adding or changing a status requires an ADR (breaking change).

### REQ-VER-02 · Verdict from runner output only

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-1, ADR-0002

**Acceptance criteria**

- [x] AC1: Statuses are computed only by `computeStatus` in `@qajitsu/verifier` from runner attempts and assertions.
- [x] AC2: No agent has a tool that sets or changes a status.
- [x] AC3: A runner claiming "passed" while an assertion failed yields FAILED; "passed" without assertions never yields PASSED.

### REQ-VER-03 · Write bans for agents

- Status: implemented
- Priority: must
- Stage: 1
- Related: INV-2, INV-3

**Acceptance criteria**

- [x] AC1: The guard denies agent writes to `results/`, `evidence/`, `plan/plan.approved.yaml`, `journal/` and `run.json`.
- [x] AC2: The guard denies paths outside the run workspace and tools not allowed for the stage (default deny).
- [x] AC3: The guard wraps every tool call of the agent loop, including MCP tools.

### REQ-VER-04 · Tool-call journal

- Status: implemented
- Priority: must
- Stage: 1
- Related: REQ-OBS-01

**Acceptance criteria**

- [x] AC1: Every allowed and denied tool call is appended to `journal/events.jsonl` with time, run, stage, tool and decision.
- [x] AC2: Tool arguments and result summaries are journaled after masking.

### REQ-VER-05 · Evidence manifest with hashes

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-7

**Acceptance criteria**

- [x] AC1: Runners write `evidence/manifest.json` with SHA-256, size, case and step for every file.
- [x] AC2: Reports reference evidence by hash; a missing file or hash mismatch fails a publish gate.
- [x] AC3: PASSED requires complete evidence; otherwise NEEDS_REVIEW.

### REQ-VER-06 · Independent auditor

- Status: implemented
- Priority: must
- Stage: 7
- Related: INV-5, REQ-LLM-02

**Acceptance criteria**

- [x] AC1: A separate agent with fresh context receives the approved plan, raw results and evidence (including images).
- [x] AC2: Its findings can only downgrade PASSED to NEEDS_REVIEW.
- [x] AC3: By default the auditor uses a different model than the author.

### REQ-VER-07 · Publish gates

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-PLAN-06, REQ-CFG-06, REQ-PUB-01

Nothing leaves the machine unless every gate passes.

**Acceptance criteria**

- [x] AC1: Every approved case has exactly one status; nothing outside the approved plan is reported.
- [x] AC2: The approved plan hash matches.
- [x] AC3: Every PASSED has at least one executed `verify()` and evidence for every step.
- [x] AC4: Every FAILED records expected and actual values and evidence of the failing step.
- [x] AC5: All manifest files exist with matching hashes.
- [x] AC6: Secret scan finds no registered secret value.
- [x] AC7: No gates run means not ok.

### REQ-VER-08 · Computed numbers and validated summary

- Status: implemented
- Priority: must
- Stage: 3
- Related: INV-6

**Acceptance criteria**

- [x] AC1: All counts in matrix, report and comment are computed from structured results.
- [x] AC2: An LLM-written summary is checked: every number equals the computed value and every case id exists with the stated status; otherwise the summary is rejected and a template summary is used.

### REQ-VER-09 · Canary check

- Status: implemented
- Priority: could
- Stage: 7
- Related: REQ-VER-02

**Acceptance criteria**

- [x] AC1: Optionally, one step per run is executed with an inverted expectation; it must fail.
- [x] AC2: If the canary passes, the whole run becomes NEEDS_REVIEW.

### REQ-VER-10 · Human preview before publishing

- Status: implemented
- Priority: must
- Stage: 4
- Related: REQ-PUB-01

**Acceptance criteria**

- [x] AC1: The final matrix and comment are shown for confirmation before publishing (default on).
- [x] AC2: `--auto-publish` or CI configuration may skip the preview; the choice is recorded in `run.json`.

### REQ-VER-11 · Bug fix verification: fails before, passes after

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-3, REQ-ENV-03, REQ-CTX-01, REQ-VER-02

For a ticket of type Bug, QAJitsu first reproduces the defect on the version before the fix (the test must fail),
then runs the same test on the version with the fix (it must pass). Strong evidence that the fix works.

**Acceptance criteria**

- [x] AC1: For Bug tickets the plan marks reproduction cases; `qj run --fix-check` runs them on the base commit and on the fix commit, each built from its own worktree.
- [x] AC2: The same approved spec runs on both versions; the spec hash is recorded for both runs.
- [x] AC3: The fix is verified only if the case is FAILED before and PASSED after; any other combination (passed before, failed after, BLOCKED or FLAKY on either side) is reported as not verified with the reason.
- [x] AC4: The report and Jira comment show both results side by side with their evidence.

### REQ-VER-12 · Failure triage hints

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-5, INV-6, REQ-VER-06

For every FAILED case an agent suggests the likely cause, to cut noise when reviewing results. The status stays FAILED;
the label is only a hint.

**Acceptance criteria**

- [x] AC1: Each FAILED case gets a hint: `product-bug`, `test-bug`, `environment` or `data`, with a short justification citing evidence (step, request, screenshot, log).
- [x] AC2: The hint never changes the status; a hint that cites no existing evidence is dropped.
- [x] AC3: Matrix, report and Jira comment show the hint visibly as a suggestion, separate from the computed status and counts.
- [x] AC4: A model error or invalid output leaves the case without a hint; the run continues.

### REQ-VER-13 · Why a case was BLOCKED

- Status: implemented
- Priority: should
- Stage: later
- Related: REQ-VER-12, INV-1, INV-5

A BLOCKED case says that the test could not judge the application, but not always what to do about it. An agent
explains the cause and the next step in the user's terms; the status stays BLOCKED.

**Acceptance criteria**

- [x] AC1: Each BLOCKED case gets a hint: `spec` (the generated test is wrong, e.g. an operation a native app does not have), `plan` (an expectation names something the application does not show), `environment`, `tooling` (device, browser, Appium) or `configuration`, with a next step and citations of the error, the spec line, the journal or the page source.
- [x] AC2: The hint never changes the status; a hint without an existing citation is dropped; a model error leaves the case without a hint.
- [x] AC3: `qj run` prints the hint under the summary table, and the report and matrix show it as a suggestion, separate from the computed status.

### REQ-VER-14 · Mutation check of a change

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-VER-11, REQ-VER-09, REQ-VER-12, REQ-VER-13, REQ-EXEC-17, REQ-EXEC-19, REQ-ENV-03, REQ-LLM-06, INV-1, INV-3, INV-6
- Note: TO BE REVIEWED (owner, 2026-10-16): agreed as a direction, to be thought through before accepting (cost per mutant, which languages and operators first, how equivalent mutants are handled).

Green results of a ticket say the tests passed, not that they would catch a mistake in the change. `qj mutate` builds
copies of the changed code with small, deliberate mistakes (mutants), runs the same approved specs against each one,
and reports which mistakes the tests caught and which they let through. It measures the tests; it never changes the
ticket's statuses.

**Acceptance criteria**

- [ ] AC1: `qj mutate <TICKET>` needs a run whose approved specs PASSED on the unchanged code (the baseline) and whose environment can be built from the worktree; only cases PASSED in the baseline take part, and without a baseline or a buildable environment the command stops with the reason.
- [ ] AC2: Code creates the mutants, never a model: only in lines the change touched, with a fixed catalogue of operators (comparison, boolean, arithmetic, constant ±1, removed call, changed return value) and a seed, up to `--max <n>` (default 10); each mutant is its own worktree copy recorded as a diff with its SHA-256.
- [ ] AC3: Each mutant is built and run like `qj run --build` in its own environment, through the lanes and in parallel within limits, with the approved specs only and no model call; the approved plan and specs are hash-checked before every mutant.
- [ ] AC4: Per mutant code computes: killed (a case that PASSED in the baseline is FAILED), survived (every such case still PASSED), or not counted (build or start failure, BLOCKED, FLAKY, time-out), with the reason; not counted is never reported as killed.
- [ ] AC5: `--with-regression` also runs the promoted regression packs (REQ-EXEC-17) against every mutant; the report gives the score of the ticket's tests and of tests plus regression separately, and names the tests that killed each mutant.
- [ ] AC6: The report (`mutation/report.html`, `.md`, JSON) shows the score, every surviving mutant with its file, line and diff, and the evidence of killed ones; a person can mark a survivor as equivalent (no behaviour change) with a reason, recorded and kept out of the score.
- [ ] AC7: `qj mutate promote <TICKET> --mutant <id>` turns a survivor into a draft plan case that targets it; it runs only after plan approval.
- [ ] AC8: Mutation results are journaled and hashed like other check records, are never published as test results or change a case status, and `qj bench` can report each model's mutation score as a measure of the tests it writes.
- [ ] AC9: Optionally a model proposes mutants that fit the ticket (e.g. rounding before summing); they are applied by code to changed lines only, labelled as model-proposed, and judged like the others.
- [ ] AC10: A mutant that is not counted (does not build, does not start, BLOCKED, time-out) is replaced by the next one from the same seed, up to twice `--max` attempts and never more; the report separates valid mutants (killed and survived) from not counted ones with their reasons and logs, and warns when too few valid mutants remain for the score to mean much.
- [ ] AC11: Besides the static report, a model may analyse the results: why each survivor got through, the missing case to add (as a draft for `qj mutate promote`), groups and priorities of weak spots, and candidates for equivalent mutants; every statement cites an existing mutant diff, line, test or evidence and is dropped without one, numbers are checked against the computed results and the text is rejected on mismatch, and the analysis is shown as a suggestion with its model, hashed like other check records, never changing the score or marking a mutant equivalent.

### REQ-VER-15 · Verifiable test certificate

- Status: implemented
- Priority: should
- Stage: 9
- Related: REQ-VER-05, REQ-OBS-05, REQ-VER-16

Every run ends with one signed statement that ties together everything the run used and produced, so anyone can check later that nothing was changed after the fact.

**Acceptance criteria**

- [x] AC1: Each published report includes a certificate: hash of the frozen plan, evidence manifest hash, matrix hash, tool versions, deployed version, time.
- [x] AC2: The certificate is signed with a project key.
- [x] AC3: `qj verify-report <path>` checks the signature and all hashes and reports any changed file.
- [x] AC4: All files of the audit trail (REQ-VER-16) form a Merkle tree; the certificate holds its root hash, so one changed byte anywhere changes the root.
- [x] AC5: The certificate uses a standard attestation format (an in-toto statement in a DSSE envelope) with a published schema.
- [x] AC6: Signing keys come from the secret provider or a KMS/HSM; keys can be rotated and old certificates stay verifiable with the public key that signed them.
- [x] AC7: The Jira comment and `report.html` show the certificate id, the root hash and how to verify it.
- [x] AC8: With a signing key, a run is certified when it ends; without one, the run seals the hashes of its results and specs in the journal, and the audit trail reports any later change, so no result can be edited before the certificate is issued. The statuses in the certificate are computed from the files at issue time, never copied from the run record.
- [x] AC9: `qj verify-report` also fails on files added after the certificate, on a certificate shown with another run's folder and on an archive with two entries of the same name; it reports bytes appended to journals and logs after the certificate, and where its trust in the signing key comes from (`--key` or `.qa/keys/`).

### REQ-VER-16 · Complete audit trail

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-VER-04, REQ-VER-05, REQ-OBS-05, REQ-PLAN-06, INV-7

Everything that influenced the verdict is recorded and hashed, not only the results.

**Acceptance criteria**

- [x] AC1: The trail covers: ticket snapshot at the start, commit SHA and diff reference, every plan version with its approval (who, when, which version), generated test code, runner and tool versions, container image digests, deployed environment version, raw runner output, all evidence, matrix and report.
- [x] AC2: The agent journal is part of the trail: prompts, model responses, tool calls with arguments and results, provider, model name and version, token counts.
- [x] AC3: Secrets are masked before hashing (REQ-CFG-06); the hash covers exactly the stored, masked content.
- [x] AC4: A run whose trail is incomplete (missing file, hash mismatch) cannot publish a certificate; the gap is reported.
- [x] AC5: The trail can be exported as one archive for an external auditor, readable without QAJitsu.

### REQ-VER-17 · Trusted timestamps

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-VER-15

**Acceptance criteria**

- [ ] AC1: The certificate's root hash can be timestamped by an RFC 3161 time-stamping authority configured per project.
- [ ] AC2: Qualified electronic timestamps under eIDAS can be used by configuring a qualified trust service provider.
- [ ] AC3: The timestamp token is stored with the certificate and checked by `qj verify-report`.
- [ ] AC4: Only the hash is sent to the authority, never content.
- [ ] AC5: An unavailable authority does not block the run; the certificate is marked "not timestamped" and can be timestamped later.

### REQ-VER-18 · Public and private transparency logs

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-VER-15, REQ-VER-17

**Acceptance criteria**

- [ ] AC1: Opt-in: the certificate can be recorded in a transparency log, publicly (Sigstore Rekor) or privately (a self-hosted log run by the customer).
- [ ] AC2: Opt-in: the root hash can be anchored with OpenTimestamps.
- [ ] AC3: Only hashes and the signature go to a public log; signing uses a service identity, never a personal account or e-mail.
- [ ] AC4: `qj verify-report` confirms the log's inclusion proof when there is one.

### REQ-VER-19 · Immutable evidence storage

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-VER-16, REQ-WS-03

**Acceptance criteria**

- [ ] AC1: Evidence and certificates can be stored in write-once storage (for example S3 Object Lock in compliance mode) with a retention period per project.
- [ ] AC2: During retention, cleanup (REQ-WS-03) skips locked runs and says so.
- [ ] AC3: Storage location and retention are recorded in the certificate.

### REQ-VER-20 · Reproduce a run from its certificate

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-VER-15, REQ-PLAN-06, REQ-EXEC-01

Anyone with access can run again exactly what was approved and compare.

**Acceptance criteria**

- [ ] AC1: `qj reproduce <certificate>` runs the frozen plan again with the same generated tests, runner versions and image digests against a chosen environment, without any agent step.
- [ ] AC2: The new run produces its own certificate and a comparison with the original: same, different or not reproducible per case.
- [ ] AC3: Differences are never merged into the original run; the original certificate stays unchanged.

### REQ-VER-21 · Open verifier and audit documentation

- Status: implemented
- Priority: should
- Stage: 9
- Related: REQ-VER-15, REQ-NFR-06

**Acceptance criteria**

- [x] AC1: The verifier is open source, works offline and needs no QAJitsu account or server.
- [x] AC2: The certificate and manifest formats are documented so a third party can write its own verifier.
- [x] AC3: The documentation states what a valid certificate proves (nothing was changed after the run, who approved what, what ran) and what it does not prove (that the plan covered every risk).

### REQ-VER-22 · Cross-layer consistency checks

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-EXEC-07, REQ-ENV-01

**Acceptance criteria**

- [ ] AC1: A case can assert that a value shown in the UI equals the API response and the stored record.
- [ ] AC2: Database reads are read-only, use a configured test connection and are limited to allowlisted tables.
- [ ] AC3: A layer that cannot be read makes the case BLOCKED, never PASSED.

### REQ-VER-23 · Test code quality gate

- Status: implemented
- Priority: must
- Stage: 7
- Related: REQ-EXEC-03, REQ-VER-06, REQ-VER-09, REQ-VER-14, INV-1, INV-4

An agent can write a bad test, like a person. The gate catches before the run the generated tests whose assertions do
not depend on the application. Planned expectations without a `verify()` are already rejected (REQ-EXEC-03/AC2).

**Acceptance criteria**

- [x] AC1: Assertions whose result does not depend on the application are rejected: comparing constants, a value with itself, or the checked response with itself or a value derived from it (tautology).
- [x] AC2: Code that can skip or swallow an assertion is rejected: an empty or swallowing `catch` around a `verify()`, a condition or an early `return` that lets a `verify()` be skipped, and skipped or disabled cases (`test.skip`, `test.fixme`, `.only`).
- [x] AC3: An assertion on a too general target is rejected: the whole page, body or response where the plan names a specific field or element.
- [x] AC4: A spec that fails the gate is not run; it goes back to the author with the findings once (as REQ-EXEC-03/AC4), then the case is BLOCKED with the findings, never PASSED.
- [x] AC5: Every rule has a lying-agent test in the adversarial suite; the findings of the gate are listed in the case's record and in the report.

### REQ-VER-24 · Human review of test code on demand

- Status: implemented
- Priority: could
- Stage: 7
- Related: REQ-VER-23, REQ-PLAN-04, REQ-EXEC-03, INV-1

For a new project, a QA lead can read the generated tests before they run until the team trusts them.

**Acceptance criteria**

- [x] AC1: Turned on per project (for example for the first N runs or until switched off) or per run with a flag; off by default.
- [x] AC2: With it on, generated specs wait for a person after the automatic checks; the person sees each spec next to its planned steps and expectations, and accepts it or sends it back with a reason.
- [x] AC3: A spec sent back goes to the author once with the reason, then the case is BLOCKED; an unreviewed spec never runs.
- [x] AC4: Each decision is recorded with the reviewer, the spec's SHA-256 and the time, in the run record and the journal; the report shows which specs a person reviewed.
- [x] AC5: The review can only stop a spec; it never sets or changes a status.
