# 0001. Use TypeScript in a pnpm monorepo

- Status: Accepted
- Date: 2026-10-03
- Related: REQ-NFR-01, REQ-GEN-02, REQ-EXEC-04, REQ-EXEC-05, REQ-EXEC-06; plan section 3

## Context

QAJitsu drives Playwright (web and API), WebdriverIO with Appium (mobile) and MCP servers, all of which are native to the Node.js ecosystem. Agents generate test code that must be checked before it runs. The framework is meant to be open source and attract QA engineers as contributors.

## Decision

Write the framework and the generated tests in TypeScript (strict), on Node.js 22 LTS, ESM only, as a pnpm workspaces monorepo with one package per responsibility and adapters as separate packages.

## Alternatives considered

- **Python**: richest LLM ecosystem and large QA community, but Playwright's Python runner is less complete, MCP servers stay in Node anyway (two ecosystems), and type checking of generated code is weaker in practice.
- **JavaScript without types**: same ecosystem, but no compile-time check of agent-written code.
- **Rust**: single binary and speed that this I/O-bound tool does not need; no official Playwright bindings; generated tests would still be TypeScript or Python.

## Consequences

- Good: one language end to end; `tsc --noEmit` acts as a gate against hallucinated APIs in generated tests.
- Bad: TypeScript tooling configuration (ESM, project references) costs setup time; types are compile-time only, so Zod is still required at runtime boundaries.
- Follow-up: a pytest runner adapter can be added later without changing the core.
