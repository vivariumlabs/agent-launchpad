import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    // Mirrors runtime (SPEC-M2C §4): the foundry/anvil suite runs only via `npm run test:integration`.
    exclude: [...configDefaults.exclude, "test/integration/**"],
  },
});
