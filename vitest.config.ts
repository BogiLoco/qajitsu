import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  resolve: {
    // Tests run against package sources, never against stale dist/ builds.
    alias: [
      { find: /^@qajitsu\/adapter-(.+)$/, replacement: `${root}packages/adapters/$1/src/index.ts` },
      { find: /^@qajitsu\/core\/errors$/, replacement: `${root}packages/core/src/errors.ts` },
      { find: /^@qajitsu\/([a-z-]+)$/, replacement: `${root}packages/$1/src/index.ts` },
    ],
  },
  test: {
    include: [
      "packages/**/src/**/*.test.ts",
      "tests/adversarial/**/*.test.ts",
      "tests/contract/**/*.test.ts",
      "tests/golden/**/*.test.ts",
      "scripts/**/*.test.mjs",
    ],
    environment: "node",
    restoreMocks: true,
    coverage: {
      provider: "v8",
      // Add a package here when it gets its first implementation.
      include: ["packages/{core,guard,steps,verifier,report,models,agents,cli}/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/src/interfaces/**", "packages/cli/src/bin.ts"],
      reporter: ["text-summary", "html", "lcov"],
      thresholds: {
        lines: 80,
        branches: 80,
        functions: 80,
        statements: 80,
        // Trust core: see .claude/rules/trust-core.md and REQ-NFR-02.
        "packages/{guard,verifier,steps}/src/**": {
          lines: 95,
          branches: 95,
          functions: 95,
          statements: 95,
        },
      },
    },
  },
});
