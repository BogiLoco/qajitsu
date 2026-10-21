# Agent skills (SKILL)

Instead of training a model, QAJitsu learns better and cheaper ways to plan and author tests as versioned skills (instructions, checklists, templates, examples and deterministic helpers). Skills are maintained continuously from approved work, evaluated before use and never change the invariants.

### REQ-SKILL-01 · Skill format and progressive loading

- Status: proposed
- Priority: should
- Stage: 7
- Related: REQ-PLAN-14, REQ-LLM-12

**Acceptance criteria**

- [ ] AC1: A skill is a versioned package: a short description of when it applies, instructions, a checklist, case templates, approved example plans and optional deterministic helper scripts.
- [ ] AC2: Only skill descriptions are in the agent's context by default; the full body is loaded when the skill applies to the ticket.
- [ ] AC3: Helper scripts replace model steps where possible (for example API cases generated from an OpenAPI document) and run under the same guard as other tools.
- [ ] AC4: The skills used for a plan are listed in the plan and the report.

### REQ-SKILL-02 · General and project skill libraries

- Status: proposed
- Priority: should
- Stage: 7
- Related: REQ-SKILL-01, REQ-SKILL-04, REQ-SKILL-06, REQ-PRJ-04, REQ-PLAN-15, REQ-CTX-07
- Note: TO BE REVIEWED: overlaps project knowledge (REQ-CTX-07, `.qa/knowledge/`) and lessons (REQ-PLAN-15); decide whether lessons become project skills or stay separate.

**Acceptance criteria**

- [ ] AC1: General skills (login, payments, roles and permissions, forms, CRUD APIs) ship with the open-source core and are built only from public or fictional data.
- [ ] AC2: Project skills are built from the project's own work and stored in the project home; they never leave the project or the customer's installation.
- [ ] AC3: A project skill can override a general one; the override is visible in the skill list.
- [ ] AC4: A project can add its own skills for each agent role (analyst, planner, author, healer, auditor, approver, explorer); a skill declares the roles it applies to and is loaded only for them.
- [ ] AC5: Project skills live in the project (`.qa/skills/<name>/` in the repository or the project home), so a team improves QAJitsu for its product itself, without changing QAJitsu; adding, listing and disabling them works from the CLI.
- [ ] AC6: A project skill goes through the same review, evaluation and signing as any other (REQ-SKILL-04, REQ-SKILL-06) and cannot weaken the invariants.

### REQ-SKILL-03 · Skill candidates from approved work

- Status: proposed
- Priority: could
- Stage: 9
- Related: REQ-PLAN-04, REQ-PLAN-15, REQ-VER-16

**Acceptance criteria**

- [ ] AC1: Periodically, approved plans, revisions and results are scanned for recurring patterns (for example cases testers always add for a kind of feature).
- [ ] AC2: A candidate skill or a change to an existing skill is proposed with the examples it came from.
- [ ] AC3: Only human-approved plans and runner results are used; ticket text is untrusted data and cannot become an instruction without review.
- [ ] AC4: An external prompt-optimisation library may be used behind an interface; its output goes through the same evaluation and review.

### REQ-SKILL-04 · Skill evaluation gate: quality first, then cost

- Status: proposed
- Priority: must
- Stage: 9
- Related: REQ-SKILL-03, REQ-LLM-06, REQ-PLAN-14, REQ-VER-14

**Acceptance criteria**

- [ ] AC1: A candidate is compared with the current version on a frozen benchmark of the project's tickets plus the demo shop.
- [ ] AC2: It passes only if plan acceptance without changes, coverage and mutation score are not worse.
- [ ] AC3: Among the candidates that pass, lower tokens and runner minutes per ticket win; the measured difference is shown.
- [ ] AC4: The results of every evaluation are stored and can be inspected.

### REQ-SKILL-05 · Model-specific skill variants

- Status: proposed
- Priority: could
- Stage: 9
- Related: REQ-SKILL-01, REQ-LLM-03, REQ-LLM-12

**Acceptance criteria**

- [ ] AC1: One skill can have variants per model family (layout for prompt caching, more examples for smaller models, shorter text for local models).
- [ ] AC2: Each variant is evaluated on its own (REQ-SKILL-04).
- [ ] AC3: A registry records the best skill and model pair per role and proposes a cheaper pair when it passes the gate.

### REQ-SKILL-06 · Skill review, signing and traceability

- Status: proposed
- Priority: must
- Stage: 7
- Related: REQ-SKILL-01, REQ-VER-16, INV-1, INV-3

**Acceptance criteria**

- [ ] AC1: A new or changed skill is enabled only after review by a configured QA lead, who sees the diff against the previous version.
- [ ] AC2: Enabled skills are signed; the hash of every skill used is recorded in the run's audit trail.
- [ ] AC3: A skill cannot change verdict computation, plan freeze, approval or coverage checks; the guard denies skill scripts the same writes it denies agents.

### REQ-SKILL-07 · Skill maintenance

- Status: proposed
- Priority: should
- Stage: 9
- Related: REQ-SKILL-04, REQ-LLM-13, REQ-PLAN-16

Skills are maintained like code: they age when the application, the team's rules or the models change.

**Acceptance criteria**

- [ ] AC1: Scheduled evaluation (for example weekly or after a configurable number of tickets) of all enabled skills against the current benchmark.
- [ ] AC2: A skill whose results drop below its gate, or that has not been used for a configurable period, is flagged for review or deprecation.
- [ ] AC3: A model change for a role triggers evaluation of the skills that role uses.
- [ ] AC4: A maintenance report lists changes, savings, regressions and pending reviews; deprecated skills stay in history and can be restored.
