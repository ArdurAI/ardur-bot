import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("compares a frozen task from the composer and opens separate outputs", async ({
  page,
}, testInfo) => {
  await signup(page, `compare-${Date.now()}@ardurbot.test`, "password12", "Compare");
  await completeOnboarding(page);
  await rpc(page, "bots/create", {
    name: "Reviewer",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: false,
  });
  await page.reload();
  await page.locator("textarea").fill("Explain why sources matter in a comparison.");
  await page.getByRole("button", { name: "Compare with…", exact: true }).click();
  await page.getByRole("checkbox", { name: "Reviewer", exact: true }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText(/hosted providers may bill per run/)).toBeVisible();
  await page.getByRole("button", { name: "Start comparison", exact: true }).click();
  await expect(page.getByTestId("compare-panel")).toBeVisible();
  await expect(page.locator("[data-comparison-bot]")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "delegation-comparison");
});
