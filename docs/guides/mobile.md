# Mobile testing (stage 8)

Mobile cases (`type: mobile` in the plan) run on a real device or emulator through Appium. As for web
cases (ADR-0004), the spec runs in the sandbox and only sends `ui.*` operations; the trusted parent drives
the app with WebdriverIO, reads the screen itself and compares it with the approved plan.

## What runs where

| Platform | Where                                                       | Driver                        |
| -------- | ----------------------------------------------------------- | ----------------------------- |
| Android  | an emulator QAJitsu starts and stops, or a connected device | Appium + UiAutomator2         |
| iOS      | a device farm (BrowserStack, Sauce Labs)                    | Appium + XCUITest on the farm |

iOS on the local machine needs a Mac with Xcode; without a farm configured, iOS cases are BLOCKED with that
reason (REQ-ENV-06/AC3). Mobile cases run one after another on one device (REQ-EXEC-06/AC3), after the API
and web cases.

## Setup (macOS, Android)

```sh
brew install openjdk@17 --cask android-commandlinetools
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
sdkmanager --sdk_root=$HOME/Library/Android/sdk "cmdline-tools;latest" "platform-tools" "emulator" \
  "platforms;android-34" "build-tools;34.0.0" "system-images;android-34;google_apis;arm64-v8a"
pnpm install                                   # Appium is a dev dependency of the repository
APPIUM_HOME=$PWD/.appium node_modules/.bin/appium driver install uiautomator2@8.7.0
```

## Configuration

```yaml
test_types: [api, web, mobile]
mobile:
  recording: retain-on-failure # screen recording per case: always | retain-on-failure | off
  appium: { bin: ../node_modules/.bin/appium, home: ../.appium } # or url: http://127.0.0.1:4723
  android:
    app: { source: ci, repo: app, artifact: app-debug, file: "*.apk" } # GitHub Actions / GitLab CI of the SHA
    # app: { source: path, repo: app, path: build/app.apk }
    # app: { source: build, repo: app, command: [./gradlew, assembleDebug], output: app/build/outputs/apk/debug/app-debug.apk }
    app_id: com.example.shop
    activity: .MainActivity
    deep_link_scheme: shop # ui.goto("/cart") opens shop://cart
    intent_args: "--es api_url {{base_url}}" # {{base_url}}: the environment as the emulator sees it
    emulator: { avd: qajitsu, system_image: "system-images;android-34;google_apis;arm64-v8a", headless: true }
  ios:
    bundle_id: com.example.shop
    farm:
      {
        provider: browserstack,
        username: secret://env/BS_USER,
        access_key: secret://env/BS_KEY,
        device: iPhone 15,
        os_version: "17",
      }
```

App binaries come from CI for exactly the analysed commit (REQ-ENV-06/AC1): the newest successful GitHub
Actions run or GitLab pipeline of that SHA with the named artifact (GitLab: job name). Downloads go to the
run's `env/app/`, which cleanup removes.

## Security notes

- `app: { source: build }` runs the analysed branch's build script on this machine, so it only runs with
  `qj run --build`. It gets an allowlisted environment and a throwaway `HOME` inside the run's `env/`.
- App paths and build outputs must stay inside the worktree (symlinks are resolved).
- Artifacts are capped at 500 MB; `intent_args` may not contain shell metacharacters.
- Appium listens on loopback under a random base path, because the emulator can reach the host's
  loopback through 10.0.2.2. Traffic from the app on the device is **not** filtered by the environment
  allowlist (only the runner's own requests and the browser are); use an emulator network policy or a
  proxy (`-http-proxy`) when the app under test must not reach other hosts.
- Device farms receive the app id you uploaded (`farm.app`), never a local path; vendor-side video and
  logs are off unless `farm.vendor_recording: true` (they are stored by the vendor, outside the secret scan).

## Writing mobile specs

Selectors: `testid:` and `label:` are accessibility ids (Android `contentDescription`, iOS
`accessibilityIdentifier`), `text:` is the visible text. `role:` and `css:` do not exist in native apps.

```ts
await step("S3", async () => {
  await ui.back(); // the Android back button
  await ui.waitFor("testid:cart-count");
  verify(
    "S3",
    "elements.testid:cart-count.text",
    undefined,
    plan.expect("TC-01.S3.elements.testid:cart-count.text"),
  );
});
```

`ui.as(alias)` is not available in native apps: log in through the app's screens with test data aliases.

## Evidence (REQ-EVD-03)

- a screenshot after every step (`S1.png`, ...), a full screenshot on failure;
- the screen recording per case (`screen.mp4`), kept on failure by default;
- device logs (`logcat.log` or `syslog.log`), masked;
- the page source of the failing screen (`page-source.xml`).

## Demo

`examples/demo-shop/android` is a small native app (Java, built without Gradle by `android/build.mjs`) with
BUG-08: the back button from checkout empties the cart when `BUG_ANDROID_BACK_EMPTIES_CART` is on. The
self-test `tests/e2e/mobile-cli.e2e.test.ts` runs `qj run DEMO-6 --build` on an emulator with the bug off
(PASSED) and on (FAILED).
