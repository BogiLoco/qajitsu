import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.js";

// End-to-end suite on examples/demo-shop (Docker, mock model, mock Jira). Arrives in roadmap stage 3.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ["tests/e2e/**/*.e2e.test.ts"],
      passWithNoTests: true,
      testTimeout: 300_000,
      coverage: { enabled: false },
    },
  }),
);
