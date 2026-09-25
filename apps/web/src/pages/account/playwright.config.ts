import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "*.browser.ts",
  workers: 1,
  timeout: 90000,
  use: {
    baseURL: "http://127.0.0.1:5191",
    permissions: ["local-network-access"],
    viewport: { width: 1100, height: 900 },
    screenshot: "only-on-failure",
  },
  webServer: {
    command: "pnpm dev --host 127.0.0.1 --port 5191 --strictPort",
    url: "http://127.0.0.1:5191",
    timeout: 120000,
    reuseExistingServer: false,
  },
});
