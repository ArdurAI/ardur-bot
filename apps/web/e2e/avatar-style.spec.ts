import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("account settings show seal and organic previews and persist the selected style", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `avatar-style-${stamp}@example.test`, "password12", "Avatar style QA");
  await completeOnboarding(page);

  const settings = await openUserSettings(page, "account");
  await expect(settings.getByRole("group", { name: "Avatar", exact: true })).toBeVisible();

  const robot = settings.getByTestId("avatar-style-robot");
  const organic = settings.getByTestId("avatar-style-organic");
  await expect(robot).toBeVisible();
  await expect(organic).toBeVisible();
  await expect(robot).toHaveAttribute("aria-pressed", "true");
  const seal = robot.locator(".ardur-bot-avatar");
  await expect(seal).toBeVisible();
  await expect(seal).toContainText("A");
  await expect(seal).toHaveAttribute("aria-hidden", "true");
  await expect(seal.locator("svg")).toHaveCount(0);
  await expect(organic.locator(".ardur-organic-avatar")).toBeVisible();
  await expect(robot.locator(".ardur-organic-avatar")).toHaveCount(0);
  await expect(organic.locator(".ardur-bot-avatar")).toHaveCount(0);

  await captureScreenshot(page, testInfo, "account-avatars-style-previews");
  await settings.getByRole("textbox", { name: "What should your bots call you?" }).fill("Captain");
  await organic.click();
  await settings.locator("form").first().getByRole("button", { name: "Save", exact: true }).click();
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
