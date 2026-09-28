import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("shared guided setup renders a deterministic four-step pilot", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html");
  await expect(page.getByRole("heading", { name: "Set up Ardur" })).toBeVisible();
  await expect(page.locator(".guided-step")).toHaveCount(9);
  await expect(page.getByText("Waiting for you", { exact: true })).toBeVisible();
  await expect(page.getByRole("status")).not.toBeInViewport();
  await expect(page.getByText("Start Ardur services")).toBeVisible();
  await captureScreenshot(page, testInfo, "guided-setup-web-fixture");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".guided-setup button")
      .first()
      .evaluate((button) => getComputedStyle(button).transitionProperty),
  ).toBe("none");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await captureScreenshot(page, testInfo, "guided-setup-web-fixture-dark");
});
