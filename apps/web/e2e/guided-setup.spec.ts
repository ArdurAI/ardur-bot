import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("shared guided setup shows the services choice", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=services");
  await expect(page.getByRole("heading", { name: "Set up Ardur" })).toBeVisible();
  await expect(page.locator(".guided-step")).toHaveCount(9);
  const services = page.locator('.guided-step[aria-current="step"]');
  await expect(services).toContainText("Start Ardur services");
  await expect(services.getByText("Waiting for you", { exact: true })).toBeVisible();
  await expect(services.getByRole("checkbox", { name: "Run on startup" })).not.toBeChecked();
  await expect(page.getByRole("status")).not.toBeInViewport();
  await captureScreenshot(page, testInfo, "guided-setup-services");
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
  await captureScreenshot(page, testInfo, "guided-setup-services-dark");
});

test("shared guided setup keeps optional computer states distinct", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=engines");
  const engines = page.locator('.guided-step[aria-current="step"]');
  await expect(engines).toContainText("Check optional computers");
  await expect(engines.getByRole("listitem")).toHaveCount(3);
  await expect(engines.getByRole("listitem").nth(0)).toContainText("Found; connection not checked");
  await expect(engines.getByRole("listitem").nth(1)).toContainText("Connected");
  await expect(engines.getByRole("listitem").nth(2)).toContainText("Unavailable");
  await captureScreenshot(page, testInfo, "guided-setup-engines");
});

test("shared guided setup shows a re-check without resetting rows", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=recheck");
  const current = page.locator('.guided-step[aria-current="step"]');
  await expect(current).toContainText("Check this computer");
  await expect(current.getByText("Checking…", { exact: true })).toBeVisible();
  await expect(page.locator('.guided-step[data-status="succeeded"]')).toHaveCount(5);
  await captureScreenshot(page, testInfo, "guided-setup-recheck");
});
