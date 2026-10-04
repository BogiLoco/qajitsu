---
"@qajitsu/core": minor
"@qajitsu/cli": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-mobile": minor
"@qajitsu/adapter-codehost-github": minor
"@qajitsu/adapter-codehost-gitlab": minor
---

Stage 8: mobile. `@qajitsu/adapter-runner-mobile` drives Android (UiAutomator2) and iOS (XCUITest, device farms) apps
through Appium with WebdriverIO from the trusted parent; specs use the same `ui.*` API plus `ui.back()`. QAJitsu
starts and stops the Android emulator and the Appium server, takes the app from CI artifacts of the change SHA
(`downloadArtifact` for GitHub Actions and GitLab CI), a worktree file or a build command, runs mobile cases
sequentially on the device, and records a screenshot per step, the screen recording, logcat/syslog and the page
source on failure. Unavailable platforms (iOS without Xcode or a farm) make cases BLOCKED with the reason. New
`mobile` config section; `UiDriver` gains `back()`.
