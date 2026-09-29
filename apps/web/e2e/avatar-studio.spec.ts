import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("bot settings open Avatar Studio on the Bot tab", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-studio-${stamp}@example.test`, "password12", "Avatar Studio");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);

  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();

  await settings.getByTestId("avatar-studio-trigger").click();
  const studio = page.getByTestId("avatar-studio");
  await expect(studio).toBeVisible();
  await expect(studio.getByText("Avatar Studio", { exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Bot", exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Upload", exact: true })).toBeVisible();
  await expect(studio.getByRole("button", { name: "Generate" })).toHaveCount(0);
  await expect(studio.getByTestId("avatar-studio-bot-tab")).toBeVisible();
  await expect(studio.getByText("Shape", { exact: true })).toBeVisible();
  await expect(studio.getByText("Color", { exact: true })).toBeVisible();
  const preview = studio.locator(".ardur-bot-avatar").first();
  await studio.getByRole("button", { name: "Seal" }).click();
  await expect(studio.getByRole("button", { name: "Seal" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(preview.locator("svg")).toHaveCount(0);
  await studio.getByRole("button", { name: "hex" }).click();
  await expect(studio.getByRole("button", { name: "hex" })).toHaveAttribute("aria-pressed", "true");
  await expect(preview.locator("svg path")).toHaveCount(1);

  await captureScreenshot(page, testInfo, "avatar-studio-bot-tab");
});
