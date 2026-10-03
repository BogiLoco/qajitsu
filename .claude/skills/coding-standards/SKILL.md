---
name: coding-standards
description: TypeScript coding standards for QAJitsu - strict typing, Zod at boundaries, errors, async, logging, module layout, TSDoc. Use when writing or reviewing any TypeScript in packages/ or examples/.
user-invocable: false
---

# QAJitsu coding standards

## Compiler and modules

- `tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noImplicitOverride`, `verbatimModuleSyntax`, `module`/`moduleResolution` `NodeNext`, target ES2023.
- ESM only. Relative imports end in `.js`. Import types with `import type`.
- One public entry per package: `src/index.ts`. Everything else is internal; cross-package imports go through the entry.

## Types and validation

- No `any`. External data is `unknown` until parsed by a Zod schema. Export both the schema and the inferred type:

```ts
export const RunIdSchema = z.string().regex(/^\d{8}-\d{4}-[a-z0-9]{4}$/);
export type RunId = z.infer<typeof RunIdSchema>;
```

- Discriminated unions for states; exhaustive switches end with `default: return assertNever(x)`.
- Prefer `readonly` arrays and properties for data that crosses functions.
- Branded types for identifiers that must not mix (`TicketKey`, `RunId`, `Sha`).

## Errors

- Library code throws subclasses of `QajitsuError` from `@qajitsu/core/errors` (`ConfigError`, `AdapterError`, `GuardDeniedError`, `GateFailedError`, ...) with a stable `code` and a `context` object. Never put secrets in messages or context.
- Expected failures that drive control flow (a gate fails, an env is unreachable) return a result object, not an exception.
- At the CLI boundary, map errors to exit codes (0 passed, 1 failed, 2 blocked/flaky/needs-review, 3 framework or config error).

## Async and side effects

- No floating promises (`@typescript-eslint/no-floating-promises`). Pass `AbortSignal` through long operations; respect it.
- Side effects (fs, network, exec, clock, random) enter through injected ports so tests can replace them.
- Shell: `execa(cmd, args, { cwd, env })`. Never `shell: true`, never string concatenation.

## Logging

- `pino` logger injected per stage with `{ run, ticket, stage }` bindings. Levels: `debug` internals, `info` stage transitions, `warn` degraded behaviour, `error` failures. Values pass through the masker before logging.

## Size and shape

- Functions small and single-purpose (split above ~50 lines). Files above ~400 lines get split by responsibility.
- Prefer plain functions and object literals over classes; classes only for errors and stateful adapters.
- No premature plugin systems: an interface plus a factory keyed by config `type` is enough.

## TSDoc

Every export documents what it does, parameters, return value, thrown errors, and for entry points a compiling `@example`. Comments explain why, not what.

## Naming

`camelCase` values and functions, `PascalCase` types and classes, `kebab-case.ts` files, tests `*.test.ts` next to the file. Booleans read as questions (`isApproved`, `hasEvidence`).
