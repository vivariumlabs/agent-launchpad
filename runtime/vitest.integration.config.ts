// SPEC-M2C §4: `npm run test:integration` — foundry/anvil chain suite only.
// Plain `npm test` (vitest.config.ts) excludes test/integration/** and stays hermetic.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    // forge build + anvil + Deploy/Lifecycle scripts run in beforeAll.
    hookTimeout: 900_000,
    testTimeout: 120_000,
    // One anvil on one port: never run integration files in parallel.
    fileParallelism: false,
  },
});
