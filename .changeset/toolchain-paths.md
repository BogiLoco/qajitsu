---
"@qajitsu/toolchain": minor
"@qajitsu/adapter-runner-web": patch
"@qajitsu/adapter-runner-mobile": patch
"@qajitsu/cli": patch
---

`androidSdkRoot` and `channelExecutables` move to `@qajitsu/toolchain`, so `qj doctor` and the tool versions can find the
Android SDK and branded browsers without the runner plugins (REQ-GEN-11/AC1). The runners still re-export them.
`qj setup --smoke` loads the mobile runner plugin only when it boots an emulator.
