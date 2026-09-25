import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("customization settings share searchable lists and hide native pages on web", async ({
  page,
}, testInfo) => {
  await signup(page, `customization-${Date.now()}@ardurbot.test`, "password12", "Fixture user");
  await completeOnboarding(page);
  await openUserSettings(page);
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByTestId("settings-nav-extensions")).toHaveCount(0);
  await expect(settings.getByTestId("settings-nav-developer")).toHaveCount(0);
  for (const section of ["skills", "integrations", "plugins"]) {
    await settings.getByTestId(`settings-nav-${section}`).click();
    await expect(settings).toHaveAttribute("data-settings-section", section);
    await expect(settings.getByRole("tab", { name: "Yours", exact: true })).toBeVisible();
    await expect(settings.getByRole("searchbox")).toBeVisible();
    await settings.getByRole("tab", { name: "Catalog", exact: true }).click();
    await captureScreenshot(page, testInfo, `customization-${section}`);
  }
  await expect(settings.getByTestId("settings-nav-connectors")).toHaveCount(0);
  await settings.getByTestId("settings-nav-mcp").click();
  await expect(settings.getByRole("heading", { name: "Default servers" })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Enable", exact: true })).toHaveCount(2);
  await captureScreenshot(page, testInfo, "customization-mcp");
});
