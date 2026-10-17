---
"@qajitsu/cli": minor
"@qajitsu/core": minor
"@qajitsu/report": minor
---

Command-line exploratory sessions can be watched live (REQ-EXEC-24/AC9-AC11): one line per action, every rejected
answer and observation as they happen; `--headed` shows every command with its output as it arrives, typed answers,
Ctrl+C and background output; `--slow-mo <ms>` paces it. The terminal is recorded as
`evidence/recordings/terminal.cast` (asciicast v2) and `terminal.txt`, in the manifest, with the transcript in
`report.html`. `qj logs --follow` keeps following while another `qj` process holds the run, e.g. an exploratory
session (REQ-OBS-02/AC3).
