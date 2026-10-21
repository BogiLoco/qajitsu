---
"@qajitsu/cli": patch
"@qajitsu/agents": minor
---

`qj doctor` reports a missing tool once (the Android SDK covers its emulator, Appium its drivers, Docker Compose),
warns when `.env.local` can be read by other users of the machine (`chmod 600`), and `qj doctor --models` checks only
the models, including the approval flow's model (REQ-GEN-08).
