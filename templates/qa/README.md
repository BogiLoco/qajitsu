# `.qa/` template

Everything QAJitsu needs to know about a project lives in the project's own `.qa/` folder (REQ-GEN-01); onboarding
a project needs no change to QAJitsu code. `qajitsu init` generates the start of it; this folder shows the layout.

| Path               | Purpose                                                                                                                                                                                                                                                    | Requirement                    |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `qa.project.yaml`  | Jira, code hosts, repos, environments, models, test types, services and build, hooks, mobile, verification, telemetry                                                                                                                                      | REQ-GEN-01, REQ-CFG-01         |
| `envs/<name>.yaml` | Environment profiles: base URL, health and version paths, accounts as aliases with `secret://` passwords, login, web session, flags                                                                                                                        | REQ-ENV-01, REQ-ENV-07         |
| `auth/<script>`    | Login helpers for logins one JSON request cannot do (form, cookies, SSO). Referenced as `login: { script: auth/<script> }` in a profile; run by QAJitsu, never by an agent; they print `{ "headers": {...}, "session"?: "..." }` and the values are masked | REQ-GEN-01/AC2, REQ-CFG-07     |
| `hooks/`           | `seed` after `--build` starts the app; `setup` before and `teardown` after the cases of every run (`hooks:` in `qa.project.yaml`), with `BASE_URL` and the run marker `QAJITSU_RUN`                                                                        | REQ-GEN-01/AC2, REQ-ENV-04/AC2 |
| `knowledge/`       | Domain notes and glossary the analyst and planner read                                                                                                                                                                                                     | REQ-CTX-07                     |
| `stubs/<name>/`    | WireMock or Mockoon mappings for stubbed dependencies in local builds                                                                                                                                                                                      | REQ-ENV-05                     |
| `routes.yaml`      | Route patterns for the transition graph and the application map                                                                                                                                                                                            | REQ-OBS-06, REQ-OBS-07         |
| `bench.yaml`       | Model benchmark cases                                                                                                                                                                                                                                      | REQ-LLM-06                     |

A login script receives `BASE_URL`, `QAJITSU_ALIAS`, `QAJITSU_USERNAME` and `QAJITSU_PASSWORD` and nothing else from
the environment. Example `auth/form-login.mjs`:

```js
const res = await fetch(`${process.env.BASE_URL}/session`, {
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ user: process.env.QAJITSU_USERNAME, pass: process.env.QAJITSU_PASSWORD }),
});
if (!res.ok) process.exit(1);
process.stdout.write(JSON.stringify({ headers: { cookie: res.headers.get("set-cookie").split(";")[0] } }));
```

Hooks receive `BASE_URL`, `QAJITSU_RUN`, `QAJITSU_TICKET` and `QAJITSU_ENV`, no secrets. A failing `setup` makes
every case BLOCKED with its log as evidence; a failing `teardown` is a warning and changes no status.
