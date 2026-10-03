# demo-shop

A small, fictional shop used to test QAJitsu itself (REQ-NFR-04). Everything here is invented; no real company data.

It has known bugs that can be switched on with feature flags ([BUGS.md](BUGS.md)). The self-test is simple:
with a bug's flag on, the case that targets it must end **FAILED**; with the flag off, it must end **PASSED**.
If QAJitsu ever reports PASSED for a seeded bug, the trust layer is broken.

## Status

| Part                                                                         | Stage | State   |
| ---------------------------------------------------------------------------- | ----- | ------- |
| `.qa/qa.project.yaml`, `tickets/` fixtures                                   | 1     | present |
| REST API (products, cart, orders, auth) with seeded API bugs, Docker Compose | 3     | planned |
| Web UI with seeded UI bugs                                                   | 5     | planned |
| Mobile build (Android)                                                       | 8     | planned |

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
