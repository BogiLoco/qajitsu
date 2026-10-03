# 0004. The trusted parent performs every call and drives the browser; specs run sandboxed

- Status: Accepted
- Date: 2026-10-03
- Related: REQ-EXEC-02, REQ-EXEC-04, REQ-EXEC-05, REQ-EXEC-07, REQ-EVD-01, REQ-EVD-02, INV-1, INV-2, INV-4, INV-8, INV-10; ADR-0002

## Context

Specs are written by the author agent and healed by the healer agent, so they are untrusted code. The stage-3
security and integrity reviews showed that a spec running in the same process as the recorder, or a sandboxed
spec that reports its own results, can fake verdicts and evidence (prototype patching, forged IPC results,
`actual` equal to `expected`). REQ-EXEC-05/AC1 names Playwright Test as the web runner, which would run spec code
in the same process as the browser and the reporter.

## Decision

Specs run in a Node process with the permission model: read access to the spec folder only, no writes, no network,
no child processes, no secrets. Every effect goes through a small set of IPC operations to the parent:
`beginStep`, `endStep`, `call` (HTTP), `ui` (browser actions) and `verify`. The parent

- performs HTTP with Playwright `APIRequestContext` and drives the browser with Playwright (`playwright-core`,
  Chromium by default, Firefox and WebKit configurable), checking the environment allowlist on every request;
- records all evidence itself: request/response JSON, screenshots after every step, full-page screenshot, DOM
  snapshot, video and trace on failure, console log and HAR per case;
- computes every assertion: `expected` from the approved plan, `actual` from its own recorded response or the live
  page, `pass` by deep equality. Values sent by the spec are ignored.

We use Playwright's browser automation directly instead of the Playwright Test runner. Selectors use Playwright's
locators (`getByTestId`, `getByRole`, `getByLabel`, `getByText`; CSS only as a flagged fallback).

## Alternatives considered

- **Playwright Test runner with a custom reporter**: spec code and reporter share a process; the reporter's view of
  assertions can be manipulated, and specs need file and network access. Rejected for INV-1/INV-2.
- **`vm` contexts inside one process**: not a security boundary in Node; escapes through host objects are well known.

## Consequences

- Good: a spec can only cause actions; it cannot report outcomes, write evidence, see secrets or reach other hosts.
- Good: one recorder and one evidence format for API, web and mixed cases.
- Bad: no Playwright Test fixtures, projects or `expect` matchers inside specs; the steps API is the only API.
- Bad: every UI action crosses IPC; acceptable for end-to-end tests, measured in the benchmark (REQ-LLM-06).
