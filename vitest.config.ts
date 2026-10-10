import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^\.\/device-listener\.js$/,
        replacement: path.join(root, "apps/desktop/scripts/device-listener-entry.ts"),
      },
      {
        find: /^\.\/desktop-guardrails\.js$/,
        replacement: path.join(root, "apps/desktop/scripts/host-guardrails-entry.ts"),
      },
      {
        find: /^\.\.\/fleet-discovery\.js$/,
        replacement: path.join(root, "apps/desktop/scripts/fleet-discovery-entry.ts"),
      },
      {
        find: "@ardurbot/ui-web/components/guided-setup",
        replacement: path.join(root, "packages/ui-web/src/components/guided-setup.tsx"),
      },
      { find: "react", replacement: path.join(root, "packages/ui-web/node_modules/react") },
      { find: "react-dom", replacement: path.join(root, "packages/ui-web/node_modules/react-dom") },
    ],
  },
  test: {
    environment: "node",
    // Bound concurrent module graphs so full runs fit worker startup and test budgets.
    maxWorkers: 4,
    setupFiles: ["./packages/testkit/src/pin-test-env.ts"],
    include: [
      "scripts/*.test.ts",
      "packaging/**/*.test.ts",
      ".agents/skills/pr-watch/*.test.ts",
      "packages/*/src/**/*.test.{ts,tsx}",
      "infra/sandboxes/supervisor/src/**/*.test.ts",
      "infra/sandboxes/kubernetes/*.test.ts",
      "infra/updater/src/**/*.test.ts",
      "apps/desktop/src/**/*.test.ts",
      "apps/desktop/scripts/**/*.test.ts",
      "apps/host-service/src/**/*.test.ts",
      "apps/cli/src/**/*.test.ts",
      "apps/web/src/**/*.test.{ts,tsx}",
      "apps/web/e2e/**/*.test.ts",
      "apps/mobile/lib/**/*.test.ts",
      "apps/mobile/components/**/*.test.{ts,tsx}",
      "apps/mobile/plugins/**/*.test.js",
      "apps/api/src/**/*.test.ts",
      "apps/worker/src/**/*.test.ts",
      "apps/www/src/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
