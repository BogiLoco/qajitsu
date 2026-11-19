# Web console (WEB)

A local web console over the files the CLI writes: progress, details, plans, environments and a chat, in a playful Dojo mode or a plain Professional mode. It shows computed results; it never computes or changes a status.

### REQ-WEB-01 · Local web console

- Status: in-progress
- Priority: should
- Stage: 5
- Related: REQ-OBS-09, REQ-OBS-02, REQ-EVD-05, REQ-WEB-07, REQ-CI-07, INV-1, INV-8, ADR-0019
- Note: accepted by the owner on 2026-11-18 (MVP point 10), in three pull requests: the read-only console with its security (AC1, AC2, AC4), the plan review with the first actions (AC3, REQ-WEB-07), live run progress and the API the thin CI client uses (REQ-CI-07).

The base of the WEB area: a console in the browser over the same files the CLI writes.

**Acceptance criteria**

- [x] AC1: `qj console` serves the console on 127.0.0.1: projects, tickets, runs, plans, reports and evidence, read from the project home.
- [x] AC2: Everything shown is read from run records and evidence; the console computes no status of its own.
- [ ] AC3: Actions that change anything are explicit buttons with the same rules as the matching CLI command.
- [x] AC4: Only the person who started it can use it: it listens on 127.0.0.1, answers only requests that name that address (no DNS rebinding) and lives under a random path; the printed address signs in one browser once and that browser gets a session cookie of its own (HttpOnly, SameSite=Strict, scoped to that path and port, never the token); its pages run no script, run files (reports, pages the application returned) are shown in a sandbox nobody can frame, and it never serves the journal, `env/`, `repos/`, a link out of the run or anything outside a run's real `report/` and `evidence/` folders.

### REQ-WEB-02 · Gamified dojo avatar

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-WEB-01, REQ-OBS-01, REQ-WEB-04

A karateka avatar animates according to the current pipeline stage. It is a view only: the person watches it, nobody plays it.

**Acceptance criteria**

- [ ] AC1: The avatar has a state per pipeline stage: init enters the dojo and bows; fetch reads the scroll; analyse meditates; plan practises kata; approve bows and waits; env warms up; author drills strikes; execute spars; heal fixes the stance; verify is the sensei's inspection; report and publish get a belt or trophy; cleanup leaves the dojo.
- [ ] AC2: The stage shown is driven only by the run's journal and state (REQ-OBS-01); the avatar has no other input.
- [ ] AC3: Stage changes in the console match the CLI's progress for the same run.
- [ ] AC4: The scene needs no input at any point: no game controls, no scores to play for, no actions that wait for the person.
- [ ] AC5: Shown only in Dojo mode (REQ-WEB-04).

### REQ-WEB-03 · Outcome reactions during execution

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-WEB-02, REQ-VER-02, REQ-EVD-04, REQ-WEB-05

After approval the execute stage plays as an automatic fight that is the progress view of the run.

**Acceptance criteria**

- [ ] AC1: During execute each case result animates: PASSED breaks a board; FAILED is the bug striking back; BLOCKED or NOT_RUN interrupts the move; FLAKY stumbles then recovers; NEEDS_REVIEW has the sensei raise a hand.
- [ ] AC2: Reactions come from computed results only (REQ-VER-02); a FAILED is always shown clearly and never softened; the matrix (REQ-EVD-04) stays the authoritative record.
- [ ] AC3: The scene stays in step with the live counts of passed, failed and blocked cases.
- [ ] AC4: Each test case is a round ("Round 3/12"); its steps are the strikes of that round, driven by step events.
- [ ] AC5: A heads-up display shows round number, counts per status, elapsed time and cost, all read from the run state.
- [ ] AC6: Without new events the karateka holds a guard stance; the scene never shows progress or an outcome before code produced it.
- [ ] AC7: Parallel cases are shown as mats side by side.
- [ ] AC8: Each finished round has a marker that opens the case's evidence and logs (REQ-WEB-05).
- [ ] AC9: The summary at the end is the real matrix, not an animation.

### REQ-WEB-04 · Dojo mode and Professional mode

- Status: proposed
- Priority: should
- Stage: 5
- Related: REQ-WEB-01

**Acceptance criteria**

- [ ] AC1: Two display modes: Dojo (karateka scenes, REQ-WEB-02 and REQ-WEB-03) and Professional (plain progress bar, stage list and status counts, no animation or sound).
- [ ] AC2: Dojo is the default of the open-source local console; Professional is the default of team and enterprise installations.
- [ ] AC3: Each person can switch the mode at any time without interrupting a run.
- [ ] AC4: An administrator can disable Dojo for the whole organisation; people then cannot turn it on.
- [ ] AC5: Both modes show exactly the same data from the same run state; switching never changes a run, status or report.
- [ ] AC6: Reports, Jira comments and exports never contain Dojo elements.

### REQ-WEB-05 · Run details: live steps and logs

- Status: proposed
- Priority: should
- Stage: 5
- Related: REQ-WEB-01, REQ-OBS-02, REQ-EVD-02, REQ-CFG-06

The tester can look inside a run when they want to; by default the progress view stays simple.

**Acceptance criteria**

- [ ] AC1: A collapsible details panel is available in both modes and is closed by default.
- [ ] AC2: It shows the current case and step, step descriptions, the latest screenshot, network calls (method, URL, status, timing) and runner output as they happen.
- [ ] AC3: Logs per run, per case and per service, with filtering by level and text search, and download.
- [ ] AC4: Every value shown passes the masking layer (REQ-CFG-06); secrets are never displayed.
- [ ] AC5: Opening or closing the panel has no effect on the run.

### REQ-WEB-06 · Environment management screen

- Status: proposed
- Priority: should
- Stage: 6
- Related: REQ-ENV-01, REQ-ENV-02, REQ-ENV-04, REQ-ENV-10, REQ-CFG-07

**Acceptance criteria**

- [ ] AC1: Lists the project's environment profiles with mode, URLs, test account aliases and seed hooks; an edit produces a config change the person confirms before it is saved.
- [ ] AC2: Shows live health per service, the deployed version and whether it matches the change (REQ-ENV-02), and the time of the last check.
- [ ] AC3: Start, stop and restart for environments built locally (REQ-ENV-03); provided and preview environments offer only "check now".
- [ ] AC4: Shows start-up logs and the reason of a BLOCKED start (REQ-ENV-04).
- [ ] AC5: Secrets are shown as references only (`secret://...`) and can be replaced, never read back.

### REQ-WEB-07 · Plan review screen

- Status: accepted
- Priority: should
- Stage: 5
- Related: REQ-PLAN-04, REQ-PLAN-14, REQ-FLOW-09

**Acceptance criteria**

- [ ] AC1: Shows plan versions side by side with added, removed and changed cases.
- [ ] AC2: Shows the coverage matrix and the "changed but not tested" risk list next to the plan (REQ-PLAN-14).
- [ ] AC3: Approve, revise (free text) and edit are explicit buttons; approval states which version is frozen.

### REQ-WEB-08 · Contextual chat

- Status: proposed
- Priority: could
- Stage: 7
- Related: REQ-WEB-01, REQ-KNOW-06, REQ-LLM-02, REQ-CTX-10

A chat panel beside the screens, aware of what the person is looking at (project, ticket, plan, run, environment).

**Acceptance criteria**

- [ ] AC1: The chat gets the current context: the open ticket, plan version, run results and evidence references, within the project's code access level.
- [ ] AC2: It explains results ("why did case 3 fail?") with links to the evidence it used.
- [ ] AC3: Answers about results quote the computed statuses and counts; the chat cannot state a status that differs from the matrix.
- [ ] AC4: Role `chat` in `models.roles`; works with local models.
- [ ] AC5: Ticket text, logs and page content are untrusted data in the chat prompt.

### REQ-WEB-09 · Chat actions are proposals

- Status: proposed
- Priority: must
- Stage: 7
- Related: REQ-WEB-08, REQ-PLAN-06, REQ-VER-03

**Acceptance criteria**

- [ ] AC1: Anything the chat would change (plan revision, environment profile, project config) is shown as a proposal with a diff and an explicit confirm button.
- [ ] AC2: The chat cannot approve or freeze a plan, change a result, status or evidence, publish to Jira or move a ticket; those stay buttons for the person.
- [ ] AC3: Confirmed proposals are logged with author, time and the chat message that produced them.

### REQ-WEB-10 · Shareable run summary

- Status: proposed
- Priority: could
- Stage: later
- Related: REQ-OBS-11, REQ-WEB-03, REQ-CFG-06

**Acceptance criteria**

- [ ] AC1: A short animated summary (Dojo) or a summary image (Professional) of a finished run can be exported for sharing.
- [ ] AC2: The export holds only the ticket key, counts and duration, never URLs, data, screenshots or secrets.

### REQ-WEB-11 · Cost view

- Status: proposed
- Priority: should
- Stage: later
- Related: REQ-WEB-01, REQ-FLOW-06, REQ-LLM-11, REQ-OBS-13, INV-6
- Note: asked for by the owner on 2026-11-17, to be built after the MVP; REQ-FLOW-06 records the costs it needs.

People who run QA, and those who pay for it, need to see where the money goes: which tests and tickets are expensive,
which are cheap, and why, before the monthly budget runs out.

**Acceptance criteria**

- [ ] AC1: The console (REQ-WEB-01) shows the project's spending this month against its budget, the most and least expensive tickets and test cases, and the cost per model, role and stage, for a chosen period.
- [ ] AC2: A ticket or case shows what made it cost what it did: the stages and roles (analysis and plan for the ticket; writing, healing and auditing for each case), healing rounds and re-runs, each with tokens, model and price.
- [ ] AC3: Every number is computed by code from the run records (REQ-FLOW-06, REQ-LLM-11) and links to the runs behind it; a cost that cannot be priced shows as unknown, never as zero.
- [ ] AC4: Views can be compared over time (week, month, release) and filtered by project, component, label and model; the same numbers can be exported (CSV, XLSX).
- [ ] AC5: The view only describes: nothing in it changes a status, a plan or a budget; changing a budget is the matching config change, done explicitly.
