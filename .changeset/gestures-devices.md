---
"@qajitsu/core": minor
"@qajitsu/steps": minor
"@qajitsu/adapter-runner-api": minor
"@qajitsu/adapter-runner-web": minor
"@qajitsu/adapter-runner-mobile": minor
"@qajitsu/verifier": minor
"@qajitsu/agents": patch
"@qajitsu/cli": minor
---

Touch gestures and emulated phones (REQ-EXEC-41, REQ-EXEC-63): `ui.tap`, `ui.doubleTap`, `ui.longPress`, `ui.swipe`,
`ui.pinch` and `ui.pullToRefresh`, planned relative to their target (an element or the screen) so they work on every
screen size; native apps run them as W3C touch actions through Appium and gain `ui.scrollUntil`; web pages run them as
Chromium touch events. Each gesture's path is evidence and is drawn on the step's screenshot. `web.matrix.devices`
adds emulated devices from Playwright's list (`iPhone 15`, `Pixel 7`) next to the viewports; reports name them as
emulated. Demo shop: a touch gallery with BUG-20 (DEMO-15).
