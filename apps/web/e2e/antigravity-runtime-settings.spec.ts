import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { installPerformanceFixture } from "./performance-fixture";

test("antigravity-runtime-settings", async ({ page }, testInfo) => {
  await installPerformanceFixture(page);
  await page.route("**/rpc/runtimes/availability", (route) =>
    route.fulfill({
      json: {
        json: {
          runtimeKind: "antigravity",
          available: true,
          version: "1.2.12",
          signInStatus: "unknown",
          models: [
            {
              id: "gemini-3.8-flash-low",
              label: "Gemini 3.8 Flash (Low)",
              efforts: ["low"],
              effortMode: "model-suffix",
            },
            {
              id: "claude-sonnet-4-6",
              label: "Claude Sonnet 4.6 (Thinking)",
              efforts: [],
              effortMode: "none",
            },
          ],
        },
      },
    }),
  );
  await page.goto("/app/fixture-bot-0");
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByRole("combobox", { name: "Runs on" }).selectOption("antigravity");
  await expect(settings.getByText("Antigravity is installed (version 1.2.12)")).toBeVisible();
  await expect(settings.getByText("Sign-in unknown until the first run").first()).toBeVisible();
  await expect(settings.getByRole("combobox", { name: "Model" })).toContainText(
    "Gemini 3.8 Flash (Low)",
  );
  await captureScreenshot(page, testInfo, "antigravity-runtime-settings");
});
