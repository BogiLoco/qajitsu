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
| Web UI with seeded UI bugs (`api/web.mjs`)                                   | 5     | present |
| Android app (`android/`, DEMO-6, BUG-08)                                     | 8     | present |

## Try it

Every command runs in a registered project (ADR-0006). Once:

```sh
pnpm install && pnpm build
node examples/demo-shop/scripts/setup-demo-repo.mjs     # local git repo ~/.qa-demo/git with the DEMO-1 change
cd examples/demo-shop
alias qj="node ../../packages/cli/dist/bin.js"
export DEMO_USER_PASSWORD=any-value                     # or put it into examples/demo-shop/.env.local
qj init demo-shop --qa-dir .qa --yes                    # registers the project and makes it the active one
qj doctor                                               # tools, versions, what qj setup would install
qj setup                                                # installs what is missing (Docker, Java, Android SDK, Appium...)
```

The planner, author and auditor use the local Ollama model of `.qa/qa.project.yaml` (`ollama pull gemma4:e2b`).

| Ticket | What                                  | Fetch                             | Seeded bug (`--set api.<FLAG>=1`)                         |
| ------ | ------------------------------------- | --------------------------------- | --------------------------------------------------------- |
| DEMO-1 | cart discounts and total (API)        | `qj fetch DEMO-1`                 | `BUG_CART_TOTAL_ROUNDING`, `BUG_DISCOUNT_STACKS`          |
| DEMO-2 | orders with a negative quantity (API) | `qj fetch DEMO-2 --ref shop=main` | `BUG_ORDER_ACCEPTS_NEGATIVE_QTY`                          |
| DEMO-3 | expired session (API)                 | `qj fetch DEMO-3 --ref shop=main` | `BUG_AUTH_EXPIRED_TOKEN_OK`                               |
| DEMO-4 | checkout terms and prices (web)       | `qj fetch DEMO-4 --ref shop=main` | `BUG_CHECKOUT_BUTTON_DISABLED`, `BUG_PRICE_FORMAT_LOCALE` |
| DEMO-5 | order error toast (web + API)         | `qj fetch DEMO-5 --ref shop=main` | `BUG_SILENT_500_TOAST`                                    |
| DEMO-6 | Android cart and back button (mobile) | `qj fetch DEMO-6 --ref shop=main` | `BUG_ANDROID_BACK_EMPTIES_CART`                           |

Then for each ticket: `qj plan <T>` (review in the terminal), `qj run <T> --build` (clean app: PASSED), and in a new
run (`qj fetch`, `qj plan`, `qj approve` again) `qj run <T> --build --set api.<FLAG>=1` (the targeting case FAILED).
`qj evidence <T> --failed` shows what failed; `qj clean <T>` removes containers and worktrees.

To watch it: `qj plan <T> --build` records the app's pages and first screen for the planner; `qj run <T> --build
--slow-mo 1000` slows every browser action down; `qj explore <T> --goal "..." --headed --slow-mo 500` shows an
exploratory session live (after `qj env up <T>` in another terminal). For two browsers at once add
`web: { headless: false, matrix: { browsers: [chromium, firefox] } }` and `execution: { web_combinations: 2 }` to
`.qa/qa.project.yaml`; for two emulators add `devices: 2` under `mobile:` and `headless: false` to its emulator.

`docker-compose.dev.yml` starts the API manually on port 3000 (`node api/server.mjs --port 3000` works too, for
`qj run <T> --env local`); QAJitsu never uses it.

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
