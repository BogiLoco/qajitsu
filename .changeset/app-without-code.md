---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/report": minor
---

Mobile apps without their repository (REQ-EXEC-23): `mobile.android.app` accepts `source: file` (a local build),
`source: url` (a download from an allowlisted host, checked against `sha256`) and `source: installed` (the app already
on the device). The run records the app id, source, SHA-256 and version (via `aapt2` or `adb` when available) and the
report shows them next to "Code". A download that fails or has another SHA-256 makes the mobile cases BLOCKED with the
reason. Without code, `qj plan` also records the app's first screen for the planner (REQ-EXEC-22/AC7).
