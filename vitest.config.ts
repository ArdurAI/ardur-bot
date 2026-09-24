import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Bound concurrent module graphs so full runs fit worker startup and test budgets.
    maxWorkers: 4,
    setupFiles: ["./packages/testkit/src/pin-test-env.ts"],
    include: [
      "scripts/*.test.ts",
      ".agents/skills/pr-watch/*.test.ts",
      "packages/*/src/**/*.test.{ts,tsx}",
      "infra/sandboxes/supervisor/src/**/*.test.ts",
      "infra/updater/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.ts",
      "apps/host-service/src/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
      "apps/mobile/lib/**/*.test.ts",
      "apps/mobile/plugins/**/*.test.js",
      "apps/api/src/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
      "apps/www/src/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
