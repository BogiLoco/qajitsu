# Adapter skeleton

Replace `<Kind>`, `<kind>`, `<Name>`, `<name>`, `<Interface>`.

## `package.json`

```json
{
  "name": "@qajitsu/adapter-<kind>-<name>",
  "version": "0.0.0",
  "type": "module",
  "exports": { ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -b",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": { "@qajitsu/core": "workspace:*", "zod": "catalog:" },
  "devDependencies": { "msw": "catalog:", "vitest": "catalog:" }
}
```

## `src/config.ts`

```ts
import { z } from "zod";

/** Configuration of the <Name> <Interface> adapter, as written in `.qa/qa.project.yaml`. */
export const <Name>ConfigSchema = z.object({
  type: z.literal("<name>"),
  baseUrl: z.string().url(),
  token: z.string().startsWith("secret://"),
});

export type <Name>Config = z.infer<typeof <Name>ConfigSchema>;
```

## `src/index.ts`

```ts
import type { <Interface>, AdapterDeps } from "@qajitsu/core";
import { AdapterError } from "@qajitsu/core/errors";
import { <Name>ConfigSchema, type <Name>Config } from "./config.js";

export { <Name>ConfigSchema, type <Name>Config };

/**
 * Creates a <Interface> backed by <Name>.
 *
 * @param config - Parsed adapter configuration.
 * @param deps - Injected ports: http client, secrets, logger, clock.
 * @returns A ready <Interface> implementation.
 * @throws {AdapterError} When the configuration cannot be resolved.
 * @example
 * const host = create<Name><Interface>(config, deps);
 */
export function create<Name><Interface>(config: <Name>Config, deps: AdapterDeps): <Interface> {
  const parsed = <Name>ConfigSchema.parse(config);
  // implement interface methods here, each parsing responses with Zod
  throw new AdapterError("NOT_IMPLEMENTED", { adapter: "<name>", baseUrl: parsed.baseUrl });
}
```

## `src/<name>.test.ts`

```ts
import { describe } from "vitest";
import { run<Interface>Contract } from "../../../../tests/contract/<interface>.contract.js";
import { create<Name><Interface> } from "./index.js";
import { handlers } from "./test-handlers.js";

describe("<Name> <Interface>", () => {
  run<Interface>Contract({
    create: (deps) => create<Name><Interface>({ type: "<name>", baseUrl: "https://<name>.example.com", token: "secret://env/TOKEN" }, deps),
    handlers,
  });
});
```
