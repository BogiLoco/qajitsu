# demo-shop

A small, fictional shop used to test QAJitsu itself (REQ-NFR-04). Everything here is invented; no real company data.

It has known bugs that can be switched on with feature flags ([BUGS.md](BUGS.md)). The self-test is simple:
with a bug's flag on, the case that targets it must end **FAILED**; with the flag off, it must end **PASSED**.
If QAJitsu ever reports PASSED for a seeded bug, the trust layer is broken.

## Status

| Part                                                                         | Stage | State   |
| ---------------------------------------------------------------------------- | ----- | ------- |
| `.qa/qa.project.yaml`, `tickets/` fixtures, `scripts/setup-demo-repo.mjs`    | 1     | present |
| REST API (products, cart, orders, auth) with seeded API bugs, Docker Compose | 3     | present |
| Web UI with seeded UI bugs                                                   | 5     | planned |
| Mobile build (Android)                                                       | 8     | planned |

## Stage 1 demo

```sh
pnpm build
node examples/demo-shop/scripts/setup-demo-repo.mjs
cd examples/demo-shop && node ../../packages/cli/dist/bin.js fetch DEMO-1
```

## Stage 2 demo (local model through Ollama)

```sh
ollama pull gemma4:e2b
cd examples/demo-shop
node ../../packages/cli/dist/bin.js doctor --models
node ../../packages/cli/dist/bin.js plan DEMO-1      # analysis.json, plan/plan.v1.yaml + .md, review loop
node ../../packages/cli/dist/bin.js approve DEMO-1 --confirm-open-questions
```

## Stage 3 demo (API tests on the local environment)

```sh
export DEMO_USER_PASSWORD=<any value>          # or put it into examples/demo-shop/.env.local
node examples/demo-shop/api/server.mjs --port 3000 &   # add BUG_CART_TOTAL_ROUNDING=1 to see TC-01 fail
cd examples/demo-shop
node ../../packages/cli/dist/bin.js run DEMO-1 --env local   # after fetch, plan and approve
```

## Stage 6 demo (`--build` from the worktree with Docker Compose)

```sh
docker pull node:22-alpine
cd examples/demo-shop
node ../../packages/cli/dist/bin.js env check
node ../../packages/cli/dist/bin.js run DEMO-1 --build      # after fetch, plan and approve
node ../../packages/cli/dist/bin.js run DEMO-1 --build --set api.BUG_CART_TOTAL_ROUNDING=1   # in a new run (fetch, plan, approve again): TC-01 FAILED
node ../../packages/cli/dist/bin.js clean DEMO-1
```

`docker-compose.dev.yml` starts the API manually on port 3000; QAJitsu never uses it.

## Layout (target)

```text
examples/demo-shop/
  .qa/                 QAJitsu config for this app (also the reference example for users)
  tickets/             fictional Jira tickets used by contract and e2e tests
  api/                 REST API (stage 3)
  web/                 web UI (stage 5)
  docker-compose.yml   local build used by --build and the e2e tests (stage 3/6)
  BUGS.md              seeded bugs and their flags
```
