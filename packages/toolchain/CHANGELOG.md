# @qajitsu/toolchain

## 0.1.0

### Minor Changes

- f3cf459: Browser channels and versions (REQ-EXEC-66): `web.browser` and `web.matrix.browsers` accept `chrome`, `chrome-beta`,
  `msedge` and `msedge-beta`; `qj setup` installs the ones the matrix names (not on Linux arm64) and `qj doctor` lists
  them with the version the browser reports. Every web attempt records the exact browser and version
  (`attempts[].browser`), and the matrix, report and ticket comment name them per combination. `safari` and versioned
  entries such as `chrome@118` are accepted but run only on a device farm: without one their combinations are BLOCKED
  with the reason, never replaced by another browser, and they cannot be the primary browser. The planner also gets
  repair hints for a selector used as a `state` path and for a case without evidence.
- adb1475: API, web and mobile cases run at the same time in lanes (`execution.workers.api|web`, `execution.web_combinations`
  for several browsers of the matrix at once); `qj run --sequential` or `execution.sequential: true` runs one case after
  another. Mobile cases can use several different devices (`mobile.android.emulators` with hardware profiles,
  `mobile.ios.farm.devices`) that split the cases or each run all of them (`mobile.distribute: matrix`, status per
  device in the reports). Test account aliases can be pools (`pool:`, `lanes:`, `shared:`): each running case holds its
  own accounts, waits for a free one up to `execution.account_wait_s`, and the journal names the pool member, never the
  user name; `qj env check` warns about pools that are too small. `qj setup` installs every system image and AVD and
  counts all emulators in its memory check. `runCases` passes a login context (case, attempt, spec, lane) and releases
  the attempt's accounts when it ends.
- 58cdf54: `androidSdkRoot` and `channelExecutables` move to `@qajitsu/toolchain`, so `qj doctor` and the tool versions can find the
  Android SDK and branded browsers without the runner plugins (REQ-GEN-11/AC1). The runners still re-export them.
  `qj setup --smoke` loads the mobile runner plugin only when it boots an emulator.
- b520f06: `qj setup` installs what a project needs (Playwright browsers, Docker through Colima or Docker Engine, Eclipse Temurin
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

### Patch Changes

- Updated dependencies [322dcb3]
- Updated dependencies [18f9746]
- Updated dependencies [6da421c]
- Updated dependencies [fbf85d7]
- Updated dependencies [c3aea49]
- Updated dependencies [aabdb96]
- Updated dependencies [44e4d71]
- Updated dependencies [016d940]
- Updated dependencies [7384885]
- Updated dependencies [f65a8a4]
- Updated dependencies [9a6d3dc]
- Updated dependencies [f3cf459]
- Updated dependencies [7a85b02]
- Updated dependencies [71f8b88]
- Updated dependencies [f431a44]
- Updated dependencies [e6bc0fd]
- Updated dependencies [b85692f]
- Updated dependencies [8125f74]
- Updated dependencies [a3ab148]
- Updated dependencies [cb3a977]
- Updated dependencies [068ee8d]
- Updated dependencies [4585559]
- Updated dependencies [e387a21]
- Updated dependencies [20ae077]
- Updated dependencies [730f710]
- Updated dependencies [5661a8c]
- Updated dependencies [ac46226]
- Updated dependencies [47fac1e]
- Updated dependencies [7de9efc]
- Updated dependencies [c268171]
- Updated dependencies [693612b]
- Updated dependencies [b17d302]
- Updated dependencies [1b0fc13]
- Updated dependencies [f26a0ad]
- Updated dependencies [1595612]
- Updated dependencies [1049e36]
- Updated dependencies [0a4b201]
- Updated dependencies [59cba3d]
- Updated dependencies [856f330]
- Updated dependencies [44af6d7]
- Updated dependencies [9e47208]
- Updated dependencies [2abbf5d]
- Updated dependencies [2acbc70]
- Updated dependencies [0efd727]
- Updated dependencies [d5a352c]
- Updated dependencies [1d4802f]
- Updated dependencies [de3be18]
- Updated dependencies [e27cccf]
- Updated dependencies [2d298c8]
- Updated dependencies [dcca1a0]
- Updated dependencies [3c66a3b]
- Updated dependencies [112d074]
- Updated dependencies [b13168a]
- Updated dependencies [69a6c09]
- Updated dependencies [52ebfb2]
- Updated dependencies [8a03150]
- Updated dependencies [adb1475]
- Updated dependencies [24d21c4]
- Updated dependencies [be9804d]
- Updated dependencies [3ec9d51]
- Updated dependencies [9876a31]
- Updated dependencies [1384f6e]
- Updated dependencies [016c6f1]
- Updated dependencies [a22d313]
- Updated dependencies [df9aa5c]
- Updated dependencies [ea69cf8]
- Updated dependencies [32c1b62]
- Updated dependencies [254a8c8]
- Updated dependencies [6fb3db3]
- Updated dependencies [6f00289]
- Updated dependencies [353a30c]
- Updated dependencies [7bdae8c]
- Updated dependencies [28ab015]
- Updated dependencies [5c6c8f2]
- Updated dependencies [cbd6fbb]
- Updated dependencies [5c6c8f2]
- Updated dependencies [5c6c8f2]
- Updated dependencies [b447614]
- Updated dependencies [76edd93]
- Updated dependencies [ef6861b]
- Updated dependencies [15a7965]
- Updated dependencies [ee9111a]
- Updated dependencies [b5b577c]
- Updated dependencies [0ecb802]
- Updated dependencies [fc55fef]
- Updated dependencies [08e6842]
- Updated dependencies [5cd2348]
- Updated dependencies [24308e8]
- Updated dependencies [c2d6ffe]
- Updated dependencies [1fc2482]
  - @qajitsu/core@0.1.0
