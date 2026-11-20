import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/**
 * The tests StrykerJS runs against every mutant of a trust-critical package (REQ-NFR-14): the package's own unit tests.
 * Each `stryker/<package>.config.json` sets the vitest `dir` to `packages/<package>`, so `include` is relative to it.
 * The adversarial suite is left out on purpose: its end-to-end scenarios take seconds each and made one package's run
 * take hours; it still runs in every verify. A mutant only they would kill is a missing unit test.
 * Same aliases as `vitest.config.ts`: tests run on sources. Short timeouts: a mutant that stretches a wait is killed.
 */
export default defineConfig({
  resolve: {
    alias: [
      { find: /^@qajitsu\/adapter-(.+)$/, replacement: `${root}packages/adapters/$1/src/index.ts` },
      { find: /^@qajitsu\/core\/errors$/, replacement: `${root}packages/core/src/errors.ts` },
      { find: /^@qajitsu\/([a-z-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
    ],
  },
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
    testTimeout: 10_000,
  },
});
