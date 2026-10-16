---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-mobile": minor
"@qajitsu/adapter-env-remote": minor
"@qajitsu/report": minor
"@qajitsu/toolchain": minor
---

API, web and mobile cases run at the same time in lanes (`execution.workers.api|web`, `execution.web_combinations`
for several browsers of the matrix at once); `qj run --sequential` or `execution.sequential: true` runs one case after
another. Mobile cases can use several different devices (`mobile.android.emulators` with hardware profiles,
`mobile.ios.farm.devices`) that split the cases or each run all of them (`mobile.distribute: matrix`, status per
device in the reports). Test account aliases can be pools (`pool:`, `lanes:`, `shared:`): each running case holds its
own accounts, waits for a free one up to `execution.account_wait_s`, and the journal names the pool member, never the
user name; `qj env check` warns about pools that are too small. `qj setup` installs every system image and AVD and
counts all emulators in its memory check. `runCases` passes a login context (case, attempt, spec, lane) and releases
the attempt's accounts when it ends.
