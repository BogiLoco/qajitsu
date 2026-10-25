# Web actions and checks

What a web case can do and check, how to plan it, and what QAJitsu guarantees about it. Every action follows one
pattern (ADR-0013): the generated test asks, the trusted runner acts in the browser, inputs come from the approved
plan, and the values a check compares are read by the runner, never handed over by the test.

Requirements: REQ-EXEC-05 (web testing), REQ-EXEC-38 (uploads and downloads), REQ-EXEC-39 (frames, pop-ups, tabs),
REQ-EXEC-40 (pointer, keyboard, scroll), REQ-EXEC-56 (Shadow DOM, canvas), REQ-EXEC-61 (dialogs, time, permissions,
HTTP authentication), REQ-EXEC-64 (selectors narrowed by context), REQ-EXEC-65 (service workers, offline, installable
apps).

## Actions

| Action                                                                                 | What it does                                                             |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `ui.goto(path)`, `ui.back()`, `ui.as(alias)`                                           | open a page, go back, open the app as a test account                     |
| `ui.click`, `ui.fill`, `ui.check`, `ui.uncheck`, `ui.select`, `ui.press`, `ui.waitFor` | the basics                                                               |
| `ui.hover(sel)`, `ui.dblclick(sel)`, `ui.rightClick(sel)`                              | pointer actions: hover menus, tooltips, context menus                    |
| `ui.dragTo(sel, target)`, `ui.dragBy(sel, dx, dy)`                                     | drag and drop onto an element or by an offset (kanban, sliders, sorting) |
| `ui.keys("ControlOrMeta+A")`                                                           | keys and combinations for the page                                       |
| `ui.scrollTo(sel)`, `ui.scrollBy(dx, dy)`, `ui.scrollUntil(sel)`                       | scroll; `scrollUntil` scrolls infinite lists until the element appears   |
| `ui.upload(sel, "<file key>", ...)`                                                    | file input, a button opening the file chooser, or a drop zone            |
| `ui.download(sel)`                                                                     | clicks and keeps the file it downloads                                   |
| `ui.switchToNewPage()`, `ui.switchToOpener()`, `ui.closePage()`                        | pop-ups and new tabs                                                     |
| `ui.advanceTime(seconds)`                                                              | moves the page's clock forward (countdowns, expiring offers)             |
| `ui.setOffline(true)`, `ui.setOffline(false)`                                          | cuts the browser's network and brings it back (offline pages, sync)      |

Selectors: `testid:`, `role:<role>:<name>`, `label:`, `placeholder:`, `alt:`, `title:`, `text:`, `id:`, `css:`, and
inside iframes `frame:<selector of the iframe> >> <selector>` (nested frames chain). A selector that matches several
elements is narrowed by its context: `role:row >> has-text:Anna Smith >> role:button:Delete` (the button in the row
with that text) or `testid:card >> nth:2` (the second card); a chain has at most eight parts. Selectors reach into
open shadow roots. An element behind a closed shadow root cannot be reached by any selector; in Chromium the error
names the host so you can ask for an open root or a test id on it.

Web actions are not available in native apps yet (mobile gestures: REQ-EXEC-41); the static checks refuse them in
mobile cases before anything runs.

## Planning inputs

```json
{
  "id": "TC-01",
  "type": "web",
  "files": {
    "avatar": { "fixture": "images/avatar.png" },
    "big": { "name": "big.pdf", "type": "application/pdf", "bytes": 3000000 }
  },
  "browser": {
    "clock": "2026-12-24T11:58:00Z",
    "permissions": ["geolocation"],
    "geolocation": { "latitude": 52.23, "longitude": 21.01 },
    "service_workers": true
  },
  "steps": [
    {
      "id": "S1",
      "action": "Delete the address and cancel",
      "dialog": { "action": "dismiss" },
      "scroll_limit": 30,
      "expect": { "description": "Asked and kept", "dialog": { "type": "confirm", "message": "Delete" } }
    }
  ]
}
```

- **Files** come from the project's `.qa/fixtures/` (the path must stay inside it, symbolic links included; at most
  50 MB) or are generated from a name, type and size. A test names the key; it never passes a path or bytes.
- **The browser** of the case starts at `clock` and time flows from there; `ui.advanceTime` jumps forward.
  `permissions` and `geolocation` are granted only as listed; everything else stays denied.
- **Service workers** are blocked unless the case sets `service_workers: true`. That is accepted in Chromium only,
  where QAJitsu still sees every request of the worker and keeps it on the allowlist; in Firefox or WebKit the case is
  BLOCKED with the reason.
- **Dialogs** (`alert`, `confirm`, `prompt`, `beforeunload`) are answered as the step's `dialog` says (`accept`,
  `dismiss`, or `accept` with a `text` for a prompt). A dialog no step expected is dismissed. Every dialog is evidence
  (`S1-dialogs.json`).
- **`scroll_limit`** bounds `ui.scrollUntil` in the step (20 by default). An element that does not appear is not an
  error of the run: the step's planned check of it fails, so a broken infinite list is FAILED, not BLOCKED.

## Checks

Besides `elements.<selector>.<visible|enabled|checked|text|value>`, `texts`, `visual` and `message`:

| Field                                             | Read by the runner from                                                                                                 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `elements.<sel>.in_viewport`                      | whether the element is in the visible part of the window                                                                |
| `download.name`, `.type`, `.size`, `.sha256`      | the last file the step downloaded (`size` checks `min_bytes`/`max_bytes`)                                               |
| `download.rows`, `.texts.<n>`, `.fields.<path>`   | its content: CSV, JSON and text as they are, XLSX (first sheet) and PDF read by code                                    |
| `download.count`                                  | how many files the step downloaded                                                                                      |
| `dialog.type`, `dialog.message`                   | the last dialog of the step (message as contained text)                                                                 |
| `state.<path>`                                    | the application's test hook, `window.__QA_STATE__` by default (`web.test_state`): an object or a function returning one |
| `manifest.<name\|short_name\|start_url\|display>` | the web app manifest the page links, fetched by the runner from an allowlisted origin                                   |
| `manifest.icons`, `manifest.controlled`           | how many icons it lists; whether a service worker controls the page (the case must allow service workers)               |
| `visual` with `element`                           | a screenshot of one element (a canvas, a chart) compared with its baseline                                              |

A check with nothing to compare never passes: no download in the step, no dialog, a page without the test hook, or
content that cannot be read is a failed check or BLOCKED with the reason.

## Evidence and safety

- Uploaded and downloaded files are evidence with their SHA-256 in the manifest. Text is masked before it is stored;
  a binary file whose extracted text holds a secret is kept only as its masked text. Downloads over 100 MB are refused
  before they are read.
- `ui-actions.json` lists every action with the page it went to when the case used pop-ups, tabs or `scrollUntil`.
- Frames, pop-ups, tabs and downloads load only origins on the environment allowlist; a pop-up to another host is
  BLOCKED with the host named. To test a payment provider's sandbox, put its host on the allowlist of that environment.
- The healer may change the selectors of every action and add waits or scrolling into view; it can never change what
  an action does (files, typed values, offsets, request bodies) or the control flow. The assertion lock compares both.

## Staging behind HTTP authentication

```yaml
# .qa/envs/staging.yaml
base_url: https://staging.example.com
http_auth: { username: qa, password: secret://vault/staging#password }
```

The browser, snapshots, exploratory sessions and the API client answer the server's authentication challenge with
these values; they are masked like every secret.

## Not covered yet

- Several users in one case (REQ-EXEC-62) and mobile web emulation with touch (REQ-EXEC-63).
- WebSocket messages of the page (REQ-EXEC-47), the clipboard's content, printing.
- Service workers in Firefox and WebKit, push notifications and the install prompt itself.
- Closed shadow roots are named only in Chromium.
