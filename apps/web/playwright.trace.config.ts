import { defineConfig } from "@playwright/test";
import performanceConfig from "./playwright.performance.config";

export default defineConfig({
  ...performanceConfig,
  testMatch: "trace-spans.spec.ts",
  outputDir: "../../.context/trace-spans/browser",
});
