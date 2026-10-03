# Contract tests

One shared suite per adapter interface (`<interface>.contract.ts`, e.g. `code-host.contract.ts`), run against every implementation with MSW handlers backed by scrubbed fixtures from `fixtures/<service>/`. The first suites (TicketSource, CodeHost, SecretProvider) arrive with the stage-1 adapters (REQ-CTX-01, REQ-CTX-02, REQ-CFG-03).

Rules: no real network, no real credentials, fixtures scrubbed (see `fixtures/README.md`). Nightly CI may additionally run the suites against sandbox accounts.
