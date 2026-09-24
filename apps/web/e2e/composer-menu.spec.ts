import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("composer menu and slash commands", async ({ page }, testInfo) => {
  await signup(page, `composer-menu-${Date.now()}@ardurbot.test`, "password12", "Composer Test");
  await completeOnboarding(page);
  await page.goto("/app");
  await page.waitForURL(/\/app\/[^/]+$/);
  await page.getByRole("button", { name: "Add files or photos", exact: true }).click();
  await expect(page.getByRole("menuitem", { name: "Slash commands", exact: true })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Add folder", exact: true })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: "Integrations", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "composer-menu");
  await page.getByRole("menuitem", { name: "Slash commands", exact: true }).click();
  await expect(page.getByTestId("slash-picker")).toBeVisible();
  await expect(page.getByTestId("slash-picker")).toContainText("/remember");
  await captureScreenshot(page, testInfo, "composer-slash-commands");
  await page.getByRole("combobox", { name: /Message/ }).press("Escape");
  await expect(page.getByTestId("slash-picker")).toHaveCount(0);
  await page.getByRole("button", { name: "Add files or photos", exact: true }).click();
  await page.getByRole("menuitem", { name: "Integrations", exact: true }).click();
  await page.getByRole("menuitem", { name: "Manage…", exact: true }).click();
  await expect(page.getByTestId("user-settings")).toHaveAttribute(
    "data-settings-section",
    "integrations",
  );
  await expect(page.getByTestId("integration-github")).toBeVisible();
});
