// `npm run test:integration` — anvil suite only (reuses runtime/test/integration/foundry.ts).
// Plain `npm test` (vitest.config.ts) excludes test/integration/** and stays hermetic.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    hookTimeout: 900_000,
    testTimeout: 180_000,
    fileParallelism: false,
  },
});
