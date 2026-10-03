# Web and mixed tests, healing, logs and evidence

Roadmap stage 5. See [ADR-0004](../adr/0004-trusted-parent-drives-api-and-browser.md) for why the browser is driven
by the trusted parent process and not by the spec.

## Writing web steps

```ts
import type { CaseContext } from "@qajitsu/steps";

export const caseId = "TC-01";

export async function run({ step, verify, plan, api, ui }: CaseContext): Promise<void> {
  await step("S1", async () => {
    await ui.as("user:standard"); // session set by QAJitsu from the environment profile
    await ui.goto("/app/checkout");
    await ui.check("testid:accept-terms");
    verify(
      "S1",
      "elements.testid:place-order.enabled",
      undefined,
      plan.expect("TC-01.S1.elements.testid:place-order.enabled"),
    );
  });
  await step("S2", async () => {
    const res = await api.as("user:standard").get("/cart"); // mixed case: verify state through the API
    verify(
      "S2",
      "fields.lines.length",
      res.json("lines.length"),
      plan.expect("TC-01.S2.fields.lines.length"),
    );
  });
}
```

- Selectors: `testid:<id>`, `role:<role>[:<name>]`, `label:<text>`, `text:<text>`; `css:<selector>` works but is flagged
  for review (REQ-EXEC-05/AC2).
- UI expectations in the plan: `texts: [...]` (visible text) and `elements: { "<selector>": { visible, enabled, checked, text, value } }`.
- `verify()` values come from the live page and the approved plan; values written in the spec are ignored.

## Evidence (REQ-EVD-02, REQ-EVD-06)

Screenshot after every step; on failure a full-page screenshot, the DOM, the Playwright trace and (by default) the
video; HAR (credentials masked) and the browser console for every case. `web.video`: `retain-on-failure` (default),
`always` or `off`. Videos over `publish.max_attachment_mb` are compressed with ffmpeg before upload.

```yaml
# .qa/qa.project.yaml
web: { browser: chromium, video: retain-on-failure, headless: true, action_timeout_ms: 5000 }
environments: { workers: 2 } # cases in parallel (REQ-EXEC-10)
# .qa/envs/<profile>.yaml
web_session: { storage: sessionStorage, key: token } # where the app keeps its session token
```

## Healer (REQ-EXEC-09)

A web case that could not run (selector or wait error, not a failed assertion) gets up to two healed attempts. The
healer may change selectors and waits only: an AST diff rejects any change to `step()`, `verify()`,
`plan.expect(...)` and any added `try/catch`. Healed specs live in `specs/healed/vN/`; the original stays. A healed
case that passes is **NEEDS_REVIEW**, never PASSED.

## `qajitsu logs` (REQ-OBS-02)

```text
qajitsu logs <TICKET> [--run <id>] [--follow] [--stage <stage>] [--agent <role>] [--case <TC-xx>]
```

`report.html` also has a timeline: every event links to the screenshot or request/response of that moment, and a
transition graph of pages and endpoints (edges green/red by outcome) built by code from the results (REQ-OBS-06).
Route patterns for the graph can be listed in `.qa/routes.yaml` (e.g. `["/product/:id"]`).

## `qajitsu evidence` and `qajitsu pull` (REQ-PUB-06)

```text
qajitsu evidence <TICKET> [--run <id>]            # opens report.html
qajitsu evidence <TICKET> --failed                # prints failures and cURL, opens failure videos
qajitsu evidence <TICKET> --trace <TC-xx>         # opens the Playwright Trace Viewer
qajitsu evidence <TICKET> --no-open               # print only (CI)
qajitsu pull <TICKET> --run <id>                  # downloads the evidence zip of a CI run from Jira and verifies its manifest
```
