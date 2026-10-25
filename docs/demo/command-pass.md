# Exploratory pass over every command (REQ-NFR-09)

Before a release, every command and subcommand is run on the demo shop in a lab with its own `HOME` (offline ticket
files, Docker, a browser, local models through Ollama). Each defect found gets a regression test that fails without
the fix, then the fix. Flows that need no person also run in `pnpm test:e2e`
(`tests/e2e/command-pass.e2e.test.ts`: a run watched while it runs, publish in file mode, export, promote, then the
regression suite; and the CI helpers with a recorded GitHub event).

How to repeat it: copy `examples/demo-shop` into a scratch folder, run `qj init` there with `HOME` pointing at a
scratch folder, and go through the table top to bottom. Record the date, the commit and every result below.

## Pass of 2026-10-25: QAJitsu testing QAJitsu (dogfood with a local model)

The built `qj` ran the whole flow (init, fetch, plan, approve, run) on DEMO-10 and DEMO-11 in a lab with its own
`HOME`, the demo shop on a local port and `gemma4:e2b` through Ollama, so every prompt, message and check met a real,
weak model. Each finding got a regression test, then the flow ran again to confirm the fix.

| ID  | Finding                                                                                                                                          | Now                                                                                  |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| D1  | the author used `ui.click()` before any `ui.goto()`: four attempts timed out on `about:blank`                                                    | static lint before the run, and the runtime error says no page is open               |
| D2  | the plan guessed texts ("Active" for "Offer active"), which gave a false FAILED                                                                  | expected texts are compared with the recorded pages and flagged for a person         |
| D3  | a change with no diff recorded no pages for the planner                                                                                          | pages are recorded whenever the change shows nothing                                 |
| D4  | pages no link reaches (`/app/offer`, `/app/addresses`) were never recorded, so D2 could not fire                                                 | the snapshot visits the pages the code defines; asset paths (`/sw.js`) are not pages |
| D5  | model repairs failed on misplaced fields: `geolocation` in `elements`, `offer-status` without `testid:`, a selector in `state`, empty `evidence` | the validation error names where the field belongs                                   |
| D6  | a model that cannot plan (context too small) was refused only after the analysis had run                                                         | refused before anything runs                                                         |
| D7  | "Confirm the deletion" planned with the dialog's check but no answer, so the dialog would be dismissed                                           | flagged in the plan: "says how to answer it"                                         |
| D8  | a time-dependent text was planned without a clock                                                                                                | the recorded-text flag says the case needs `browser.clock`                           |
| D9  | the author's prompt never listed `ui.advanceTime()`                                                                                              | listed, with `ui.setOffline()` and `manifest.*`                                      |
| D10 | `qj setup` said Docker was too old when only the Compose v2 plugin was missing                                                                   | names the missing plugin                                                             |
| D11 | a farm-only browser (`safari`) in the matrix would have run on Chromium when the cases ran through an injected executor                          | refused whatever runs the cases, never the primary browser                           |

Still weak with a 2B model, and left to the person who approves: the planner rarely plans the clock, location or the
dialog answer on its own; the flags above make each gap visible before approval.

## Pass of 2026-10-24: web gaps (uploads, downloads, frames, pop-ups, pointer, scroll, Shadow DOM, dialogs, time)

Every new web action was run through the runner and through the whole CLI (fetch, plan, approve, run, publish) on
DEMO-7..DEMO-10, clean and with each seeded bug (BUG-09..BUG-15), then reviewed critically. What was found and done:

| ID  | Finding                                                                                                                                                                                | Now                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| G1  | the assertion lock collected actions and control flow but compared neither: a healer could change a request body, a typed value or an uploaded file, drop an action or add a condition | both compared; adversarial suite "lying healer" (7 attempts refused)                 |
| G2  | a step expecting only a download or test state was refused at approval as "description only"                                                                                           | counted as something to compare                                                      |
| G3  | the plan a person approves did not show the files a case uploads or what a download must contain                                                                                       | shown: files, download, state, scroll limit                                          |
| G4  | browser dialogs were dismissed silently by the browser, so confirm-gated flows could never go on                                                                                       | answered as the step says, recorded, checkable (`dialog.*`)                          |
| G5  | no way to test time-dependent pages, browser permissions or location, or staging behind Basic Auth                                                                                     | `browser.clock`, `ui.advanceTime`, `browser.permissions`, `geolocation`, `http_auth` |
| G6  | a download of any size was read into memory                                                                                                                                            | refused over 100 MB before it is read                                                |
| G7  | "content cannot be read" of a download was reported as "not JSON"                                                                                                                      | the real reason is reported                                                          |
| G8  | a second `switchToNewPage` took the same refused pop-up again                                                                                                                          | each pop-up is taken once                                                            |
| G9  | `ui.scrollUntil` that does not find the element: an error would hide a broken infinite list as BLOCKED                                                                                 | not an error; the planned check fails (FAILED)                                       |

Still open, as requirements: several users in one web case (REQ-EXEC-62), mobile web emulation (REQ-EXEC-63),
WebSocket messages of the page (REQ-EXEC-47/AC3).

## Pass of 2026-10-22/23 (third): Jira workflow, cost and time, readiness, reproduce

Probes against `qj workflow sync`, `publish` with a workflow mapping, `fetch` admission, `plan --override-readiness`,
`feedback`, `metrics`, `status`, stage budgets and `models.max_input_tokens`, as tests with the demo shop and file
tickets. Each attack or probe, what happened before, and now:

| ID  | Attack or probe                                                                               | Before                                            | Now                                                                        |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| W1  | `/qj approve v1` written before QAJitsu posted v1                                             | approved a version nobody had seen                | refused: only comments written after the version was posted approve it     |
| W2  | `/qj revise ...` and `/qj approve v2` in one batch                                            | v2 approved right after it was written            | refused for the same reason                                                |
| W3  | `/qj reject` after an approval                                                                | run marked rejected, the approval stayed in force | ignored: a decided plan stays decided                                      |
| W4  | `/qj revise` after a reject                                                                   | the planner wrote a new version                   | ignored                                                                    |
| W5  | `/qj approve` from someone outside the approvers group                                        | -                                                 | answered and ignored                                                       |
| W6  | a plan quoting `/qj approve v1`                                                               | -                                                 | QAJitsu's own comments are never commands                                  |
| W7  | a `/qj reject` reason quoting a secret                                                        | stored unmasked in `run.json`                     | masked                                                                     |
| W8  | `plan --override-readiness` with a secret in the reason                                       | echoed unmasked to the terminal (CI logs)         | masked                                                                     |
| W9  | results edited after the run, then `publish` with a workflow                                  | -                                                 | gates fail, the ticket does not move                                       |
| W10 | broken `tickets/workflow.json` at publish                                                     | -                                                 | treated as an open workflow; result published, ticket moved                |
| W11 | a second `fetch` while a live process holds the ticket's run                                  | -                                                 | ignored and logged in `flow.jsonl`; a dead holder does not block           |
| W12 | `workflow poll` with no transition out of the start status                                    | a new run on every poll until the daily limit     | not picked up while the ticket's last run is open; `work reset` frees it   |
| W13 | webhook for a ticket in "Done" (automation fired on any update)                               | a run started                                     | the tracker's status decides: not in the start status, not picked up       |
| W14 | slow webhook client                                                                           | connection held up to Node's defaults             | headers within 10 s, the request within 15 s                               |
| W15 | whole loop: poll, `/qj approve`, run, publish                                                 | ticket stayed in "Plan review" during the run     | moves to "In QA" when the plan is approved; "QA passed" after publish      |
| T1  | real TSAs (DigiCert, Sectigo, FreeTSA): RSA tokens with intermediate certificates             | -                                                 | checked: hash, nonce, signature, purpose; DigiCert chain to its root       |
| T2  | a token that names Ed25519 but carries an ECDSA signature                                     | accepted (Node read it as ECDSA-SHA256)           | refused: the key must be of the family the token names                     |
| T3  | a certificate dated after its own timestamp; a stamp made days later                          | not compared                                      | the first fails `verify-report`; the second is shown with what it proves   |
| T4  | a token planted for another statement; a TSA answering HTTP 500, a refusal, a wrong nonce     | -                                                 | never kept when stamping; a planted one fails `verify-report` and the tool |
| S1  | archive against moto with authentication on (an S3 implementation independent of our signing) | -                                                 | SigV4 accepted, lock held as written, a wrong secret refused with 403      |
| S2  | delete a locked object version as a user allowed everything                                   | -                                                 | refused by the storage (AccessDenied) until the retention ends             |
| S3  | storage that answers 200 but holds no lock; a bucket without Object Lock                      | -                                                 | "not archived" with the reason; the run goes on; `audit archive` retries   |
| S4  | `work reset --delete` and `projects remove` on a locked run                                   | -                                                 | the run stays on disk with the date; the project is not removed            |
| C1  | `models.max_input_tokens: 50`                                                                 | -                                                 | `MODEL_INPUT_TOO_LARGE` before anything is sent, no plan                   |
| C2  | stage budgets of 1 s                                                                          | -                                                 | warning with the measured time, exit code and statuses unchanged           |
| C3  | `feedback` with `--is PASSED`, `--case ../x`, `--escaped ../../etc`, a newline key            | -                                                 | refused, nothing written                                                   |

## Pass of 2026-10-22 (second): attacks on the certificate flow

A deeper review tried to obtain or show a certificate for more than a run produced, first as tests, then live in the
lab with `local/gemma4:e2b` and Docker. Each attack, what stopped it, and what was fixed:

| ID  | Attack                                                                               | Before                                                       | Now                                                                                                                                                                                |
| --- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | edit a result between the end of the run and `publish` / `audit certify`             | certified, the edit included                                 | a run with a key is certified when it ends; every run seals results and specs                                                                                                      |
| A1b | flip the assertions of a result to pass, then publish without `certificate.required` | published with a warning                                     | `run-sealed` publish gate refuses it, with or without a key                                                                                                                        |
| A2  | change the statuses in `run.json` before certifying                                  | the certificate stated the edited statuses                   | statuses are computed from the files when the certificate is issued                                                                                                                |
| A3  | plant an evidence file after the certificate                                         | `verify-report` did not look at files it does not list       | reported as `added after the certificate` (both verifiers)                                                                                                                         |
| A4  | show a certificate with another run's folder                                         | not compared                                                 | `ticket` and `runId` compared with `run.json`                                                                                                                                      |
| A5  | edit `plan.approved.yaml` and its hash in `run.json` together before the run         | the edited plan ran; only the gate and certificate caught it | `qj run` checks the approval records against the journal first: nothing runs                                                                                                       |
| A6  | replace evidence together with a matching manifest, no key                           | not caught                                                   | the seal covers the manifest                                                                                                                                                       |
| A7  | zip with two entries of the same name                                                | the last one was checked                                     | refused                                                                                                                                                                            |
| A8  | a certificate signed with a key planted in `.qa/keys/`                               | trusted inside the project                                   | still trusted there (whoever can write the repository is trusted); the result says `from .qa/keys/<file>`, and with the project's key from another channel (`--key`) it is refused |
| A9  | an agent writes `certificate/`                                                       | not in the guard's protected paths                           | denied                                                                                                                                                                             |
| A10 | forged names with `..` in a certificate                                              | fixed in the first pass                                      | refused                                                                                                                                                                            |

Also found: in `explore --cli` a stop (Ctrl+C or the time box) that came while a command was being started, before it
listened for the stop, was missed, and the command ran to its own 20 s timeout; it is checked again once the listener
is attached. This was the cause of a test that failed only under load. Bytes appended to journals after the
certificate are reported, not failed. Rendering a certified run's reports with a newer QAJitsu can change them (a new
gate, for example); the certificate names the versions that rendered them.

## Pass of 2026-10-22: audit trail, certificate, quality gate, spec review

Commit `c3107c9`; model `local/gemma4:e2b` for every role; Docker 24.0.6 (Compose 2.23.0); macOS 14.5 arm64; a fresh
lab (`examples/demo-shop` copied, its own `HOME`, the signing key in base64 in the lab's `.env.local`).

| Command                                         | Checked                                                                                                        | Result                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `audit keygen`                                  | key created twice (rotation); private key 0600 in a 0700 folder, never printed; public keys in `.qa/keys/`     | ok                                                 |
| `run --build --review-specs` (no terminal)      | gemma writes 4 specs; the run stops before anything ran; containers and env files gone; 8 model calls stored   | ok; stops before building the environment now (E2) |
| `review-spec`, `--accept`, `--send-back`        | spec shown next to its plan; TC-04 sent back twice ends BLOCKED with the reviewer's reason                     | ok after B2, E5; the reason is an instruction now  |
| `audit trail`                                   | complete trail with image digest, versions, environment and the change records                                 | ok after B1                                        |
| `audit certify`, `publish`                      | certificate issued, reused on publish, stamped into `report.html` and the comment                              | ok after E3                                        |
| `verify-report` (project, zip outside, rotated) | valid in the project, on the zip in another `HOME` with `--key`, the old export after a key rotation           | ok                                                 |
| `audit export`, `tools/verify-certificate.mjs`  | `shasum -a 256 -c SHA256SUMS` all OK; a result edited in the export: `changed: results/TC-01.json` from both   | ok                                                 |
| tampering in the run folder                     | `verify-report` names the file; `audit certify` refuses; `publish` names the reason; re-rendered reports match | ok after E4                                        |
| quality gate on a hand-written spec             | empty catch, conditional verify, constant actual: BLOCKED with all three findings                              | ok; NOT_RUN of the other cases fixed (E6)          |

### Defects found and fixed

| ID  | Command                    | Defect                                                                                                       | Fix                                                                 |
| --- | -------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| B1  | `audit trail`              | the walk skipped `repos/` entirely: the diff and change records were neither in the trail nor certified      | only checked-out code under `repos/<alias>/` is left out            |
| B2  | `run --review-specs`       | a rewrite that failed its checks was not recorded, so the next run asked the author again                    | recorded as `rewrite_failed`; the case stays BLOCKED                |
| B3  | `run --review-specs`       | the reviewer's reason reached the author as untrusted data, which the model is told to ignore                | passed as an instruction (it comes from the person running QAJitsu) |
| E1  | `init`                     | NOT READY listed Android and Appium but not a missing Compose plugin or browser, unlike `doctor`             | both use the same missing-tool checks                               |
| E2  | `run --review-specs`       | built the Docker environment (about 20 s) only to stop for the review                                        | stops before the environment when only a person is awaited          |
| E3  | `publish`                  | printed the certificate lines twice                                                                          | once, in the comment preview                                        |
| E4  | `publish`                  | without a certificate it pointed to `qj audit trail`, which does not show a file changed after a certificate | names the reasons                                                   |
| E5  | `run --review-specs`       | the waiting message did not name cases that will not run (author failed, rewrite failed)                     | names them with the reason                                          |
| E6  | `run --cases` (env failed) | an unhealthy or failed environment made unchosen cases BLOCKED instead of NOT_RUN                            | only the chosen cases are BLOCKED                                   |

Security review of the new code: names in a forged certificate could point outside the run folder (`../..`); both
verifiers refuse them now. A reviewer's free-text reason is masked before `run.json` stores it.

## Pass of 2026-10-21

Commit `ae9a935` plus the fixes listed below; models: `local/gemma4:e2b` (planner, author), `local/qwen3:14b`
(analyst, explorer, approver); Docker 24.0.6; macOS 14.5 arm64; no Android SDK installed.

| Command                                                                                                | Checked                                                                                                                             | Result                                                                 |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `init`                                                                                                 | new repository with `ANTHROPIC_API_KEY` in `.env.local`, `--yes`                                                                    | ok; next-step text fixed (P3)                                          |
| `use`, `projects list/current/archive/unarchive/export/remove`                                         | a second project, archived, restored, exported, removed                                                                             | ok; remove now names the exported profile it deletes (P4)              |
| `projects import`                                                                                      | covered by `project-profile.test.ts`                                                                                                | not run live                                                           |
| `knowledge add/list/search/sync/reindex/remove`                                                        | README and BUGS of the demo shop                                                                                                    | ok; unquoted search words accepted (P5)                                |
| `knowledge reset`                                                                                      | covered by `knowledge.test.ts`                                                                                                      | not run live (clears the lab's base)                                   |
| `setup --check`                                                                                        | plan for a machine without the Android SDK                                                                                          | ok                                                                     |
| `setup` (install)                                                                                      | 2.3 GB Android SDK                                                                                                                  | not run live; covered by `setup.test.ts`                               |
| `doctor`, `--online`, `--models`, `--models --online`                                                  | missing Android SDK and Appium, `.env.local` mode 644/600, a fake key against the real Anthropic API, approver equal to the planner | ok after REQ-GEN-08; approver check fixed in that pass                 |
| `fetch`, `plan`, `plan --revise`, `approve`, approval flow                                             | gemma plans, qwen approves (`[model, person]`, `[model]`, Jira comments)                                                            | ok; gemma4:e2b writes descriptions instead of values, which code flags |
| `run --build`, `export`, `publish`, `publish --auto-publish`                                           | run with five FAILED cases                                                                                                          | ok; export now says what its exit code means (P1)                      |
| `test --build --dry-run`                                                                               | whole flow without a terminal                                                                                                       | ok: stops after the plan and names the commands to continue            |
| `explore`, `explore review`, `explore promote`                                                         | browser session S01 (qwen3), review of its items                                                                                    | ok; `--session` optional with one session                              |
| `env check`, `env render`, `env up`                                                                    | demo shop built from the run's worktree                                                                                             | ok                                                                     |
| `runs`, `status`, `note`, `resume`, `work reset`, `clean`, `gc --dry-run`, `clean --project --dry-run` | after several runs                                                                                                                  | ok; unquoted note text accepted (P5)                                   |
| `logs`, `evidence`, `evidence --failed`, `map`, `metrics`, `release`                                   | executed run                                                                                                                        | ok                                                                     |
| `audit verify`, `--all`                                                                                | 14 runs, one interrupted during `fetch`                                                                                             | ok: the run without a journal fails the audit, as it must              |
| `bug`                                                                                                  | five FAILED cases, no terminal                                                                                                      | ok: asks for `--yes`                                                   |
| `promote`, `regression`                                                                                | lab has no PASSED case and no tests repository                                                                                      | refused with the reason; the flow runs in `pnpm test:e2e`              |
| `watch`                                                                                                | during and after a run                                                                                                              | in `pnpm test:e2e`                                                     |
| `ci detect`, `ci publish-plan`, `ci comment`                                                           | no CI; recorded GitHub event in `pnpm test:e2e`                                                                                     | ok; a change of an unknown host is refused                             |
| `baseline accept`                                                                                      | API-only run                                                                                                                        | ok: nothing to accept                                                  |
| `telemetry export`                                                                                     | no OTLP endpoint configured                                                                                                         | ok: says so                                                            |
| `pull`                                                                                                 | file tickets                                                                                                                        | ok: refused, it needs Jira                                             |
| `answer`                                                                                               | no step waiting                                                                                                                     | ok: `NO_PENDING_STEP`                                                  |
| `pnpm demo`, `pnpm test:e2e`                                                                           | the whole offline demo and every end-to-end suite                                                                                   | ok after D2 (mobile suite skipped: no Android SDK)                     |
| `bench`                                                                                                | five cases with real models take hours                                                                                              | not run live; covered by `bench.test.ts`                               |

### Defects found and fixed

| ID  | Command                    | Defect                                                                                                                                               | Fix                                                             |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| P1  | `export`                   | exit code 1 after writing the files, without a word why                                                                                              | prints the statuses and what the exit code means                |
| P2  | `regression`               | the estimate of a run without models said "models ≈ 0k tokens (cost unknown ...)"                                                                    | says "no models"                                                |
| P3  | `init`                     | the next step said "choose models in models.roles" right after they were chosen                                                                      | names `doctor --models` instead                                 |
| P4  | `projects remove`          | deleted a profile `projects export` had just written into the project's home, silently                                                               | lists it as deleted with the project                            |
| P5  | `knowledge search`, `note` | unquoted words failed with "too many arguments"                                                                                                      | take the words as one text                                      |
| D1  | `doctor --models`          | passed an approver that was the planner's own model, which `qj approve` refuses                                                                      | flags it (REQ-GEN-08)                                           |
| D2  | `pnpm demo`                | broken since the 401 check of 2026-10-18: the recorded plan's TC-02 named no test account, so approval stopped; `pnpm test:e2e` is not part of PR CI | the recorded plan names `user:standard`, as its spec always did |
| T1  | test suite                 | the Ctrl+C clean-up test of `explore --cli` failed once under load                                                                                   | checks that the process is gone, in either list                 |

The previous pass (2026-10-17/18, findings F0–F27) is summarised in the pull requests of `feat/exploretests` and
`fix/anthropic-trial`.
