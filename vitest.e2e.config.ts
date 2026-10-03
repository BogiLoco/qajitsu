import { defineConfig } from "vitest/config";
import base from "./vitest.config.js";

// End-to-end suite: built packages (`pnpm build` first), sandboxed runner, demo-shop API, scripted models.
export default defineConfig({
  ...(base.resolve ? { resolve: base.resolve } : {}),
  test: {
    include: ["tests/e2e/**/*.e2e.test.ts"],
    environment: "node",
    passWithNoTests: false,
    testTimeout: 300_000,
    hookTimeout: 120_000,
  },
});
