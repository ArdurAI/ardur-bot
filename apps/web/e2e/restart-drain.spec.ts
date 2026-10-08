import { expect, test } from "@playwright/test";
import { captureScreenshot, openUserSettings } from "./helpers";
import { installPerformanceFixture } from "./performance-fixture";

test("a server update shows that saved turns will continue", async ({ page }, testInfo) => {
  await installPerformanceFixture(page);
  await page.route("**/rpc/updater/status", (route) =>
    route.fulfill({
      json: {
        json: {
          supported: true,
          installKind: "sidecar",
          running: true,
          version: "0.1.0",
          imageTag: "fixture",
          lastRun: null,
        },
      },
    }),
  );
  await page.goto("/");
  await openUserSettings(page, "updates");
  const settings = page.getByTestId("software-update-settings");
  await expect(settings.getByRole("status")).toHaveText(
    "Updating — your bots will continue after the update",
  );
  await captureScreenshot(page, testInfo, "server-restart-drain");
});
