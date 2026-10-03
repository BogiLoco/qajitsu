---
paths:
  - "packages/**/*.ts"
  - "examples/**/*.ts"
---

# Coding style (TypeScript)

Full guide: `coding-standards` skill. The short version:

- `strict` TypeScript, no `any` (use `unknown` + Zod), no non-null assertions (`!`) outside tests.
- Validate every external input with Zod at the boundary; inside the boundary trust the types.
- Named exports only; each package exposes its public API from `src/index.ts`.
- Prefer pure functions and immutable data (`readonly`, `as const`); side effects live in adapters.
- Functions over 50 lines or files over 400 lines are a signal to split.
- Async: no floating promises, always `await` or return; use `AbortSignal` for cancellable work.
- Errors: throw typed errors from `@qajitsu/core/errors`; include context, never secrets.
- Logging through the injected `pino` logger with structured fields; no `console.*` in `src/`.
- Every exported symbol has TSDoc (`@param`, `@returns`, `@throws`, an `@example` for public entry points).
- Names: `camelCase` values, `PascalCase` types, `SCREAMING_SNAKE_CASE` only for true constants; files `kebab-case.ts`.
