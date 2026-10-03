# End-to-end tests

Full pipeline on `examples/demo-shop`: Docker Compose app, scripted mock model, WireMock Jira. Every seeded bug in `examples/demo-shop/BUGS.md` must end as FAILED for its case, and PASSED without the bug flag (REQ-NFR-04). Files: `*.e2e.test.ts`. Run: `pnpm test:e2e`. Arrives in roadmap stage 3.
