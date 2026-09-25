import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account settings avatar style previews differ for robot and organic", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-style-${stamp}@ardurbot.test`, "password12", "Avatar style QA");
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "account");
  await expect(settings.getByRole("group", { name: "Avatar", exact: true })).toBeVisible();

  const robot = settings.getByTestId("avatar-style-robot");
  const organic = settings.getByTestId("avatar-style-organic");
  await expect(robot).toBeVisible();
  await expect(organic).toBeVisible();
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  await expect(robot.locator(".ardurbot-bot-avatar")).toBeVisible();
  await expect(organic.locator(".ardurbot-organic-avatar")).toBeVisible();
  await expect(robot.locator(".ardurbot-organic-avatar")).toHaveCount(0);
  await expect(organic.locator(".ardurbot-bot-avatar")).toHaveCount(0);

  const robotMarkup = await robot
    .locator("svg")
    .first()
    .evaluate((el) => el.outerHTML);
  const organicMarkup = await organic
    .locator("svg")
    .first()
    .evaluate((el) => el.outerHTML);
  expect(robotMarkup).not.toBe(organicMarkup);

  await captureScreenshot(page, testInfo, "account-avatars-style-previews");
  await settings.getByRole("textbox", { name: "What should your bots call you?" }).fill("Captain");
  await organic.click();
  await settings
    .locator("form")
    .filter({ has: robot })
    .getByRole("button", { name: "Save", exact: true })
    .click();
  await expect(settings.getByText("Saved", { exact: true })).toBeVisible();
  await page.reload();
  const reopened = await openUserSettings(page, "account");
  await expect(
    reopened.getByRole("textbox", { name: "What should your bots call you?" }),
  ).toHaveValue("Captain");
  await expect(reopened.getByTestId("avatar-style-organic")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
});
