import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));

/** Every test of the repository but the end-to-end suites (`vitest.e2e.config.ts`). */
const TESTS = [
  "packages/**/src/**/*.test.ts",
  "tests/adversarial/**/*.test.ts",
  "tests/contract/**/*.test.ts",
  "tests/golden/**/*.test.ts",
  "scripts/**/*.test.mjs",
  "examples/**/*.test.ts",
];

/** Tests that drive the CLI end to end or a real browser: most of the suite's time, little of its logic. */
const INTEGRATION = [
  "packages/cli/src/commands/**/*.test.ts",
  "packages/adapters/runner-web/src/{browser,browser-login,web-actions}.test.ts",
];

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
    // REQ-NFR-06/AC2: `unit` is what `pnpm verify` runs, a few minutes on a fresh four-core runner. `integration` drives
    // the CLI end to end (a real demo shop, git, a browser) and the web runner in a real Chromium; CI runs it on every
    // pull request (`pnpm verify:full`), and the coverage thresholds below are checked over both together.
    projects: [
      {
        extends: true,
        test: { name: "unit", include: TESTS, exclude: [...configDefaults.exclude, ...INTEGRATION] },
      },
      { extends: true, test: { name: "integration", include: INTEGRATION } },
    ],
    environment: "node",
    restoreMocks: true,
    // Many tests drive the CLI end to end (a real demo shop, git, a browser); 5 s is too short on CI runners.
    testTimeout: 30_000,
    coverage: {
      provider: "v8",
      // Add a package here when it gets its first implementation.
      include: [
        "packages/{core,guard,steps,verifier,report,models,agents,cli,toolchain}/src/**/*.ts",
        "packages/adapters/*/src/**/*.ts",
      ],
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
