---
"@qajitsu/core": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/cli": minor
---

Run one case with a live view (REQ-EXEC-16): `qj run --cases TC-02` runs only the chosen cases of the approved plan (the others are NOT_RUN, "not selected"); `--headed` shows the browser or the emulator window and `--slow-mo <ms>` slows browser actions; `--step` pauses before every step in the trusted parent, with the case's time limit standing still, and a stop leaves the case BLOCKED in every retry. New optional `pause` on `AttemptRequest` (`StepPause`, `PausedStep`) and `slowMoMs` on the web runner.
