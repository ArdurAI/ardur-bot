import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Team opens as a board with one row per bot", async ({ page }, testInfo) => {
  await signup(page, `team-${Date.now()}@ardurbot.test`, "password12", "Team");
  await completeOnboarding(page);
  await expect(page.getByRole("button", { name: "Team", exact: true })).toHaveCount(0);
  await rpc(page, "bots/create", {
    name: "Reviewer",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/team$/);
  await expect(page.locator("[data-team-bot]")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("combobox")).toHaveCount(0);
  const reviewer = page.locator("[data-team-bot]").filter({ hasText: "Reviewer" });
  await reviewer.locator("summary").click();
  await expect(reviewer.getByText("Tokens", { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "delegation-team-board");
});
