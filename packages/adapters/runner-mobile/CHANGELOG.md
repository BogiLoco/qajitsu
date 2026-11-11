# @qajitsu/adapter-runner-mobile

## 0.1.0

### Minor Changes

- 18f9746: Failure screenshots mark the failing element (REQ-EVD-08): when a web or mobile step fails, a copy of its screenshot gets a numbered red box around each element whose assertion failed and each region that differs from the visual baseline (`<step>-annotated.png`, with `<step>-annotations.json` listing field, expected and actual value); a missing element is noted, and with a baseline the baseline copy is marked too. The original screenshot is unchanged and no status changes. `report.html`, `qj evidence --failed`, the ticket comment and `qj bug` show the annotated copy first. New `ScreenBox`/`ScreenMark` types, `regions` on image comparisons, optional `bounds` on UI drivers and `annotate` on the case runtime.
- 6da421c: Selectors for any web or mobile application (REQ-EXEC-21): `web.test_id_attribute` (e.g. `data-qa`) for `testid:`,
  the element inventory and snapshots; new selector kinds `placeholder:`, `alt:`, `title:`, `id:` (web) and `id:`,
  `xpath:` (native apps); on Android `testid:` also finds the resource id. The inventory finds Android `@+id`, SwiftUI
  `.accessibilityIdentifier`, Flutter `Semantics(identifier:)`, `Key` and `ValueKey`. Static checks accept only the
  kinds of the case's platform and flag `xpath:` for review. Prompts list selector kinds by stability and no longer use
  demo-shop ids. A screen without any addressable element makes the case BLOCKED with that reason.
- c3aea49: Snapshot of the running application (REQ-EXEC-22). Drivers list the elements a page or screen shows
  (`UiDriver.elements`, from Playwright's accessibility snapshot and test ids, or from the Appium page source). Before
  writing specs, `qj run` records each web case's pages and the app's first screen and gives the author every element
  with the selectors that find it; selectors found nowhere go back to the author once. A failed UI attempt keeps
  `failure-elements.json` for the healer, which now heals mobile cases too. `qj plan --env/--snapshot` records the
  environment's pages when the code is not available, and the plan check flags elements no recorded page shows.
- 59cba3d: Touch gestures and emulated phones (REQ-EXEC-41, REQ-EXEC-63): `ui.tap`, `ui.doubleTap`, `ui.longPress`, `ui.swipe`,
  `ui.pinch` and `ui.pullToRefresh`, planned relative to their target (an element or the screen) so they work on every
  screen size; native apps run them as W3C touch actions through Appium and gain `ui.scrollUntil`; web pages run them as
  Chromium touch events. Each gesture's path is evidence and is drawn on the step's screenshot. `web.matrix.devices`
  adds emulated devices from Playwright's list (`iPhone 15`, `Pixel 7`) next to the viewports; reports name them as
  emulated. Demo shop: a touch gallery with BUG-20 (DEMO-15).
- 8a03150: Onboarding through `.qa/` only: login scripts in `.qa/auth/` (`login: { script: auth/<file> }`) for form, cookie
  or SSO logins, and `hooks.setup` / `hooks.teardown` around every run (a failing setup makes every case BLOCKED).
  `mobile.devices` runs mobile cases on several emulators or farm sessions in parallel, one case at a time per
  device. Publishers honour an aborted signal before sending anything. `qj run` lists every configuration problem.
- adb1475: API, web and mobile cases run at the same time in lanes (`execution.workers.api|web`, `execution.web_combinations`
  for several browsers of the matrix at once); `qj run --sequential` or `execution.sequential: true` runs one case after
  another. Mobile cases can use several different devices (`mobile.android.emulators` with hardware profiles,
  `mobile.ios.farm.devices`) that split the cases or each run all of them (`mobile.distribute: matrix`, status per
  device in the reports). Test account aliases can be pools (`pool:`, `lanes:`, `shared:`): each running case holds its
  own accounts, waits for a free one up to `execution.account_wait_s`, and the journal names the pool member, never the
  user name; `qj env check` warns about pools that are too small. `qj setup` installs every system image and AVD and
  counts all emulators in its memory check. `runCases` passes a login context (case, attempt, spec, lane) and releases
  the attempt's accounts when it ends.
- abde35b: The mobile runner (Appium, Android emulators, device farms) is a plugin (REQ-GEN-11/AC1): `qj plugin add runner-mobile`; `qj setup` installs it for a project with mobile tests, together with the API runner it needs. A run with mobile cases loads it before any lane starts. `webdriverio` is pinned to `9.32.0`. A new device factory contract on a fake Appium client runs on the source and on the installed plugin.
- ee9111a: Stage 8: mobile. `@qajitsu/adapter-runner-mobile` drives Android (UiAutomator2) and iOS (XCUITest, device farms) apps
  through Appium with WebdriverIO from the trusted parent; specs use the same `ui.*` API plus `ui.back()`. QAJitsu
  starts and stops the Android emulator and the Appium server, takes the app from CI artifacts of the change SHA
  (`downloadArtifact` for GitHub Actions and GitLab CI), a worktree file or a build command, runs mobile cases
  sequentially on the device, and records a screenshot per step, the screen recording, logcat/syslog and the page
  source on failure. Unavailable platforms (iOS without Xcode or a farm) make cases BLOCKED with the reason. New
  `mobile` config section; `UiDriver` gains `back()`.
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

- 3ec9d51: The guard holds every plugin to its manifest (REQ-GEN-11/AC4+AC9, ADR-0015). `@qajitsu/guard` adds
  `checkPluginCode`. At install, and again before an installed plugin is loaded, the plugin's own code is checked
  against its permissions: Node's network, process and file modules, reads of `process.env` and the global `fetch`. A
  plugin that does more than it declares, or that refers to the frozen plan, is refused. Every HTTP call of an
  integration plugin goes through a guarded `fetch` that allows only its manifest's hosts and the URLs the project
  configures for it. Plugin manifests get the `environment` permission, and five manifests that understated their code
  are corrected.
- 1384f6e: Plugins installed on demand (REQ-GEN-11). `@qajitsu/core` adds `PLUGIN_API_VERSION`, `PLUGIN_TYPES`,
  `parsePluginManifest` and `PluginError`. Every adapter package now carries its plugin manifest under
  `qajitsu.plugin`. The CLI adds `qj plugin list|add|remove`, which installs the version a release pins from the npm
  registry, checked against its published checksum and without install scripts. `qj doctor` names missing plugins and
  `--fix` installs them, `qj setup` installs the plugins a project needs, runs record the plugin versions they used,
  and `qj knowledge` loads its stores and sources through the plugin loader.
- 6f00289: Secret managers besides `env` under `secrets:` in `qa.project.yaml`: HashiCorp Vault KV v2 (`secret://vault/<path>#<field>`),
  Doppler (`secret://doppler/<NAME>`), 1Password, AWS Secrets Manager and Google Secret Manager through their CLIs
  (`secret://op/...`, `secret://aws/...`, `secret://gcp/...`). Their own tokens come from `secret://env/...`. `pnpm demo`
  runs the whole flow on the demo-shop offline; CI reviews new dependencies and audits the installed tree.
- 58cdf54: `androidSdkRoot` and `channelExecutables` move to `@qajitsu/toolchain`, so `qj doctor` and the tool versions can find the
  Android SDK and branded browsers without the runner plugins (REQ-GEN-11/AC1). The runners still re-export them.
  `qj setup --smoke` loads the mobile runner plugin only when it boots an emulator.
- c2d6ffe: Web cases can upload and download files (checked by name, type, size, hash and CSV/JSON/XLSX/PDF content), work
  inside iframes, pop-ups and new tabs, hover, double and right click, drag and drop, press keys, scroll infinite lists,
  reach into Shadow DOM, check canvas content through the application's test hook or an element screenshot, answer
  browser dialogs, run at a planned time and move it, use browser permissions and a location, and reach staging behind
  HTTP authentication. The assertion lock now also compares actions and control flow, so a healer cannot change what a
  test does.
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
- Updated dependencies [6abb72b]
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
- Updated dependencies [3a9ffcc]
- Updated dependencies [52ebfb2]
- Updated dependencies [8a03150]
- Updated dependencies [adb1475]
- Updated dependencies [24d21c4]
- Updated dependencies [be9804d]
- Updated dependencies [3ec9d51]
- Updated dependencies [9876a31]
- Updated dependencies [b41852e]
- Updated dependencies [1384f6e]
- Updated dependencies [016c6f1]
- Updated dependencies [a22d313]
- Updated dependencies [df9aa5c]
- Updated dependencies [ea69cf8]
- Updated dependencies [32c1b62]
- Updated dependencies [254a8c8]
- Updated dependencies [6fb3db3]
- Updated dependencies [ab42592]
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
- Updated dependencies [58cdf54]
- Updated dependencies [b520f06]
- Updated dependencies [08e6842]
- Updated dependencies [5cd2348]
- Updated dependencies [24308e8]
- Updated dependencies [c2d6ffe]
- Updated dependencies [1fc2482]
- Updated dependencies [88da4fa]
  - @qajitsu/core@0.1.0
  - @qajitsu/steps@0.1.0
  - @qajitsu/adapter-runner-api@0.1.0
  - @qajitsu/toolchain@0.1.0
