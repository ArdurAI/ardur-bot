import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testMatch: "shell-performance.spec.ts",
  workers: 1,
  retries: 0,
  timeout: 90_000,
  reporter: [["list"]],
  outputDir: "../../.context/performance/browser",
  use: {
    baseURL: "http://127.0.0.1:55420",
    headless: true,
    viewport: { width: 1440, height: 900 },
    trace: "on",
  },
  webServer: {
    command: "pnpm exec vite preview --host 127.0.0.1 --port 55420 --strictPort",
    url: "http://127.0.0.1:55420",
    reuseExistingServer: false,
    env: { ARDURBOT_ALLOW_DEV_SECRETS: "1" },
  },
});
