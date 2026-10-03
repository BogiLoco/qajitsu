# `--build`, configuration and run management (stage 6)

`qajitsu run <TICKET> --build` tests the code of the change itself: it starts the application from the
worktree that `qajitsu fetch` checked out for this run (REQ-CTX-04/AC4), runs the approved plan against it and
cleans up afterwards. Without `--build`, `qajitsu run` tests a provided environment (`--env`, stage 3).

## Configuration

Two sections in `.qa/qa.project.yaml` (schema: `schemas/qa.project.schema.json`):

```yaml
services:
  api: # started from the project's compose file
    kind: compose
    compose_service: api # default: the key
    port: 3000 # container port, published on a free 127.0.0.1 port
    env:
      DEMO_USER_PASSWORD: { secret: secret://env/DEMO_USER_PASSWORD } # from the secret provider
      DATABASE_URL: { template: "postgres://{{svc.db.host}}:{{svc.db.port}}/shop" }
      BUG_FLAG: { value: "0", overridable: true } # --set api.BUG_FLAG=1
      LOG_LEVEL: info # constant
    health: { http: /health, timeout_s: 120 } # or { port: true } or { log: "ready" }
  worker: # no Docker: a managed process, logs in logs/worker.log
    kind: process
    command: ["node", "worker.mjs", "--port", "{{port}}"]
    cwd: services/worker
    env: { API_URL: { template: "{{svc.api.url}}" } }
  payments: # an external dependency replaced by a stub (listed in the report as "not real")
    kind: stub
    engine: wiremock # or mockoon
    mappings: stubs/payments # relative to .qa/

build:
  repo: shop # repository alias whose worktree is built
  compose_file: docker-compose.yml # relative to the repository; required for kind: compose
  base_service: api # its URL is the base URL of the tests
  profile: local # .qa/envs/local.yaml provides accounts, login and web session
  seed: hooks/seed.mjs # runs after readiness with BASE_URL, QAJITSU_RUN, QAJITSU_TICKET

cleanup:
  policy: on_success # always | never | on_success (keep the environment of failed runs for debugging)
  keep_last: 10 # retention per ticket, applied by `qajitsu gc`
  max_age_days: 30
```

Templates: `{{svc.<name>.host|port|url}}` and `{{port}}` (own port of a process). Containers see in-network
endpoints (`db:5432`), processes and tests see `127.0.0.1:<dynamic port>`.

Configuration layers (REQ-CFG-01): framework defaults → `.qa/qa.project.yaml` → `.qa/envs/<env>.yaml` →
secrets (secret provider) → run overrides (`--set`). The first three are committed and must not contain secrets:
`env check` rejects a variable named like a secret (`*_PASSWORD`, `*_TOKEN`, `*_SECRET`, `*_API_KEY`, ...) with a
literal value. The effective configuration, masked, is written to `run.json` (`data.config`).

## Commands

| Command                                                     | What it does                                                                                 |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `qajitsu run <T> --build [--env <profile>] [--set s.VAR=v]` | validate, start, seed, test, clean up per policy                                             |
| `qajitsu run <T> --build --keep`                            | keep containers and worktrees after this run                                                 |
| `qajitsu env check [--env <profile>]`                       | list every missing or invalid variable without starting anything (exit 3 on problems)        |
| `qajitsu env render <T> [--run <id>]`                       | recreate the per-service `.env` files (0600) with the ports recorded by `--build`            |
| `qajitsu runs <T>`                                          | runs of a ticket: status, stage, results, retention                                          |
| `qajitsu resume <T> [--run <id>] [--env\|--build]`          | continue from the last checkpoint; stops at approval and publish (human gates)               |
| `qajitsu clean <T> [--run <id>\|--all]`                     | remove containers, volumes, networks (by labels), worktrees and `.env` files; artifacts stay |
| `qajitsu gc [--dry-run]`                                    | apply retention to every ticket; runs marked `keep` and running runs are exempt              |

## What happens in `--build`

1. Validation (REQ-CFG-04/AC2): the worktree of `build.repo` must exist in this run, every secret must resolve,
   templates must name known services, `--set` may only touch `overridable` variables. Any problem: exit code 3,
   nothing started.
2. Start (REQ-ENV-03): `docker compose --project-name qj-<ticket>-<suffix> --file <worktree>/<compose_file>
--file <run>/env/compose.overlay.yml up --detach --build`. The overlay publishes each port on `127.0.0.1::<port>`,
   adds `qajitsu.ticket`, `qajitsu.run`, `qajitsu.managed` labels to services, the default network and every
   volume, and passes `env/<service>.env` files (0600). They are deleted right after `up` (REQ-CFG-05/AC2); the
   overlay is rewritten without them. Processes start with their variables in the environment, never in files.
3. Readiness (REQ-ENV-04/AC1): each service's health check with its timeout; a process that exits fails at once.
4. Seed (REQ-ENV-04/AC2): `.qa/hooks/seed.*` with the base service's variables, `BASE_URL` and the run marker;
   output in `logs/seed.log`.
5. Tests run against the built URL. The URL needs no allowlist entry: it is a loopback address this run started.
6. Start failure (REQ-ENV-04/AC3): every case is BLOCKED by code, the masked service logs are evidence in the
   manifest. No agent can mark anything as executed.
7. Cleanup (REQ-WS-03): service logs to `logs/`, then `docker compose down --volumes` and worktree removal unless the
   policy or `--keep` keeps them. Ctrl+C also stops the environment and deletes `.env` files.

`clean` and `gc` find Docker resources only by the `qajitsu.run=<id>` and `qajitsu.managed=true` labels and delete
paths only inside the run folder; symlinks are removed, never followed (REQ-WS-03/AC4). A `run.lock` file with the
owner's pid keeps two processes from writing one run; `clean` and `gc` skip runs held by a live process
(REQ-WS-04/AC2).

## Demo

```sh
docker pull node:22-alpine
node examples/demo-shop/scripts/setup-demo-repo.mjs
cd examples/demo-shop
export DEMO_USER_PASSWORD=<any value>
qj fetch DEMO-1 && qj plan DEMO-1 && qj approve DEMO-1 --confirm-open-questions
qj env check
qj run DEMO-1 --build                                         # all PASSED, everything removed
qj run DEMO-1 --build --set api.BUG_CART_TOTAL_ROUNDING=1     # in a new run (fetch, plan, approve again): TC-01 FAILED, environment kept
qj clean DEMO-1
```
