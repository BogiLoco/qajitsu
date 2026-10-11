---
"@qajitsu/toolchain": minor
"@qajitsu/cli": minor
"@qajitsu/adapter-runner-mobile": minor
---

`qj setup` installs what a project needs (Playwright browsers, Docker through Colima or Docker Engine, Eclipse Temurin
Java, the Android SDK with emulator, system image and AVD, Appium with UiAutomator2/XCUITest, Xcode through xcodes) at
pinned versions into `~/.qajitsu/toolchain/`, with prechecks, resumable checksum-verified downloads, licence
confirmation or `--yes`, smoke tests, `--check`/`--json`, `--only`/`--skip`, `--reinstall`, `--uninstall [--all]`,
`--version tool=version`, offline bundles (`--download`/`--from`) and private mirrors, proxy and company CA in
`toolchain.yaml`. Compatible tools already on the machine are used as they are and incompatible ones are never changed.
`qj doctor` shows the toolchain plan, `--fix` runs setup, `--online` checks the sources. The emulator starts with
`-no-metrics` and accepts an AVD folder (`avdHome`).

CI: the GitHub Action (input `setup`) and the GitLab template (`QA_SETUP`) run `qj setup` and cache
`~/.qajitsu/toolchain/` by QAJitsu's pinned versions and `.qa/toolchain.yaml`; `ci/docker/Dockerfile.android` builds
an image with the Android tools for KVM hosts. `qj setup --ignore-check <check>` lets an image build skip the
virtualisation precheck.
