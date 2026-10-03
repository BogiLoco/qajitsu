---
name: new-adapter
description: Add a new QAJitsu adapter - TicketSource, CodeHost, ModelProvider, EnvProvider, SecretProvider, Runner, EvidenceStore or Publisher - with contract tests, scrubbed fixtures, config schema and docs. Use for integrations like Jira Data Center, Bitbucket, Vault, a new LLM provider or a device farm.
argument-hint: "[interface] [name], e.g. CodeHost bitbucket"
---

# /new-adapter $ARGUMENTS

## 1. Locate the contract

- Interface: `packages/core/src/interfaces/<interface>.ts`. Read it and an existing implementation of the same interface (e.g. `adapters/codehost-github` for CodeHost).
- If the interface lacks something the new system needs, stop and consult the `architect` agent. Do not widen interfaces silently.

## 2. Scaffold

Create `packages/adapters/<kind>-<name>/` following [skeleton.md](skeleton.md): `package.json` (`@qajitsu/adapter-<kind>-<name>`), `src/index.ts` exporting `create<Name><Interface>(config, deps)`, `src/config.ts` with the Zod config schema, `src/<name>.test.ts`.

## 3. Contract tests first

- Every interface has a shared contract suite in `tests/contract/<interface>.contract.ts`. Import it and run it against the new adapter with MSW-backed fixtures. It must fail before you implement.
- Add adapter-specific tests for pagination, auth errors (401/403), rate limits (429 with retry-after), timeouts and malformed responses.

## 4. Record and scrub fixtures

- Record real responses only from a test account or sandbox, with `pnpm fixtures:record <service>` if available, otherwise by hand.
- Before committing, run `pnpm fixtures:scrub` (or scrub by hand): tokens, cookies, `Authorization`, emails, user and account IDs, internal hostnames become placeholders such as `<TOKEN>`, `user@example.com`, `https://jira.example.com`.
- The protect-files hook blocks writes containing obvious secrets; treat a block as a real leak, not as an obstacle.

## 5. Implement

Satisfy the contract suite. Respect: Zod-parse every response; map HTTP errors to `AdapterError` codes; `AbortSignal` on every request; no provider SDK leaks outside the package (invariant 11 for ModelProvider).

## 6. Wire it up

- Register the factory in the adapter registry for its `type` key in config.
- Extend the config schema union in `packages/core/src/config/` and regenerate config docs.

## 7. Interface-specific checks

- **CodeHost**: PR/MR discovery by ticket key, diff with renames, review comments, CI artifacts, self-hosted `base_url`.
- **ModelProvider**: capability profile (tools, structured output, vision, context window), probe used by `qajitsu doctor`, cost reporting fields.
- **EnvProvider**: labels `qajitsu.ticket`/`qajitsu.run` on every resource, health checks with timeout, cleanup by label, BLOCKED on start failure.
- **SecretProvider**: values never logged; register every resolved value with the masker.
- **Runner**: writes only through `@qajitsu/steps`; produces results JSON consumed by the verifier; evidence in the manifest.
- **Publisher**: idempotent (stores comment/execution id in `run.json`), size checks before upload.

## 8. Docs and finish

`docs/adapters/<kind>-<name>.md` (setup, scopes/permissions, limits), changeset (minor), then `/verify` and `/review-change`.
