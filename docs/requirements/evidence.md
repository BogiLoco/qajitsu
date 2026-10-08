# Evidence and test matrix (EVD)

What proof QAJitsu collects per test type and how results are summarised. All evidence is stored in the run workspace
inside the project's home (REQ-PRJ-10).

### REQ-EVD-01 · API evidence

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-EXEC-04, REQ-CFG-06

**Acceptance criteria**

- [x] AC1: One JSON file per call: method, URL, masked headers, body, status, duration, assertions with expected and actual.
- [x] AC2: A reproducible cURL command (masked) per call.
- [x] AC3: All attempts kept, numbered.

### REQ-EVD-02 · Web evidence

- Status: implemented
- Priority: must
- Stage: 5
- Related: REQ-EXEC-05

**Acceptance criteria**

- [x] AC1: Screenshot after every step.
- [x] AC2: On failure: full-page screenshot, DOM snapshot, video and Playwright trace.
- [x] AC3: Browser console log and HAR per case.

### REQ-EVD-03 · Mobile evidence

- Status: implemented
- Priority: must
- Stage: 8
- Related: REQ-EXEC-06

**Acceptance criteria**

- [x] AC1: Screenshot after every step.
- [x] AC2: Screen recording per case, kept on failure by default.
- [x] AC3: Device logs (logcat or syslog) and page source on failure.

### REQ-EVD-04 · Test matrix

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-VER-08, REQ-PUB-01

**Acceptance criteria**

- [x] AC1: One row per approved case, including cases that did not run.
- [x] AC2: Columns: case id, title, requirement/AC reference, type, status, steps passed/total, evidence summary.
- [x] AC3: A summary line with counts per status, computed by code.

### REQ-EVD-05 · Report formats

- Status: implemented
- Priority: must
- Stage: 3
- Related: REQ-EVD-04

**Acceptance criteria**

- [x] AC1: `matrix.md` (basis of the Jira comment).
- [x] AC2: `matrix.csv` and `matrix.xlsx`.
- [x] AC3: `report.html`: one self-contained file with matrix, steps, screenshots, video player and trace links.

### REQ-EVD-06 · Media policy

- Status: implemented
- Priority: should
- Stage: 5
- Related: REQ-PUB-02

**Acceptance criteria**

- [x] AC1: Video `retain-on-failure` by default, `always` configurable.
- [x] AC2: Videos compressed with ffmpeg before upload to fit Jira attachment limits.

### REQ-EVD-07 · Passive observations during tests

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-6, REQ-EXEC-04, REQ-EXEC-05

Cheap automatic checks computed by code, not by an LLM, collected while the planned cases run.

**Acceptance criteria**

- [x] AC1: Every API response seen during a run, including calls without a `verify()`, is validated against the project's OpenAPI document; mismatches are recorded (as failed contract assertions, REQ-EXEC-04/AC2) and listed with the observations.
- [x] AC2: Web runs record browser console errors and network responses with status 4xx/5xx.
- [x] AC3: Accessibility is checked with axe-core on every visited screen; violations are recorded with the rule and element.
- [x] AC4: Observations appear in the report and Jira comment as a separate section; they never change a case status or the counts.
- [x] AC5: Each check can be turned off or given an ignore list in project config.

### REQ-EVD-08 · Failure screenshots mark the failing element

- Status: implemented
- Priority: should
- Stage: later
- Related: INV-1, INV-7, REQ-EVD-02, REQ-EVD-03, REQ-EXEC-12, REQ-PUB-07

A failed web or mobile step is easier to understand when the screenshot shows where the problem is. The marking is
drawn by code from the failed assertion; it is an extra picture, never a verdict.

**Acceptance criteria**

- [x] AC1: When a web or mobile step fails on an element assertion, an annotated copy of the failure screenshot draws a red box around that element with the failed field, expected and actual value.
- [x] AC2: When the element is missing and the step has a visual baseline, the box marks where it is on the baseline; without a baseline the annotation says the element was not found and draws no box.
- [x] AC3: A visual difference above the threshold is marked with a red box around each changed region (masked regions excluded); a moved element gets a box at the old and at the new place.
- [x] AC4: The annotated screenshot is an extra evidence file in the manifest; the original stays unchanged, the annotation is drawn by code from the assertion and never changes a status.
- [x] AC5: `report.html`, `qj evidence --failed`, the ticket comment and `qj bug` show the annotated screenshot first.
