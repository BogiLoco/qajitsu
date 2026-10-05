/**
 * Mobile Runner: the trusted parent drives Android (UiAutomator2) and iOS (XCUITest) apps through
 * Appium with WebdriverIO, like the web runner drives a browser (ADR-0004); emulator and Appium server
 * management, app binaries from CI, device farms (REQ-EXEC-06, REQ-EVD-03, REQ-ENV-06).
 *
 * @packageDocumentation
 */
export {
  appiumLocator,
  createAppiumDeviceFactory,
  sourceTexts,
  type AppiumClient,
  type AppiumElement,
  type MobileRunnerOptions,
} from "./device.js";
export {
  androidSdkRoot,
  execTool,
  spawnTool,
  startAndroidEmulator,
  startAppium,
  type EmulatorOptions,
  type Exec,
  type RunningAppium,
  type RunningEmulator,
  type Spawn,
} from "./emulator.js";
export { connectAppium } from "./connect.js";

/** Adapter metadata used by `qajitsu doctor` and the adapter table in the docs. */
export const ADAPTER = {
  kind: "runner",
  name: "mobile",
  implements: "AttemptExecutor",
  roadmapStage: 8,
  requirements: ["REQ-EXEC-06", "REQ-EVD-03", "REQ-ENV-06"],
  status: "implemented",
} as const;
