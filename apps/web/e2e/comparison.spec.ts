import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("compares a frozen task from the composer and opens separate outputs", async ({
  page,
}, testInfo) => {
  await signup(page, `compare-${Date.now()}@example.test`, "password12", "Compare");
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
  // Nothing floats above the composer; comparing starts from its + menu.
  await expect(page.getByRole("button", { name: "Compare with…", exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Add files or photos", exact: true }).click();
  const compare = page.getByRole("menuitem", { name: "Compare with…", exact: true });
  await expect(compare).toBeVisible();
  await captureScreenshot(page, testInfo, "delegation-compare-menu");
  await compare.click();
  await page.getByRole("checkbox", { name: "Reviewer", exact: true }).check();
  await page.getByRole("button", { name: "Preview", exact: true }).click();
  await expect(page.getByText(/hosted providers may bill per run/)).toBeVisible();
  await page.getByRole("button", { name: "Start comparison", exact: true }).click();
  await expect(page.getByTestId("compare-panel")).toBeVisible();
  await expect(page.locator("[data-comparison-bot]")).toHaveCount(2);
  await captureScreenshot(page, testInfo, "delegation-comparison");
});
