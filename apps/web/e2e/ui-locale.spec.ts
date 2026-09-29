import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("general settings language picker includes Simplified Chinese and applies it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-zh-cn-${stamp}@example.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page, "general");
  await expect(
    settings.getByRole("heading", { name: "General", exact: true }).first(),
  ).toBeVisible();
  await expect(settings.getByRole("group", { name: "Language", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "简体中文", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-zh-cn");

  await page.getByRole("option", { name: "简体中文", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "通用", exact: true }).first()).toBeVisible();
  await expect(settings.getByRole("group", { name: "语言", exact: true })).toBeVisible();
  await expect(picker).toHaveText("简体中文");
  await captureScreenshot(page, testInfo, "ui-locale-settings-zh-cn");
});

test("general settings language picker includes Korean and applies it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-ko-${stamp}@example.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page, "general");
  await expect(
    settings.getByRole("heading", { name: "General", exact: true }).first(),
  ).toBeVisible();
  await expect(settings.getByRole("group", { name: "Language", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "한국어", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-ko");

  await page.getByRole("option", { name: "한국어", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "일반", exact: true }).first()).toBeVisible();
  await expect(settings.getByRole("group", { name: "언어", exact: true })).toBeVisible();
  await expect(picker).toHaveText("한국어");
  await captureScreenshot(page, testInfo, "ui-locale-settings-ko");
});

test("general settings language picker includes Spanish and applies it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-es-${stamp}@example.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  const settings = await openUserSettings(page, "general");
  await expect(
    settings.getByRole("heading", { name: "General", exact: true }).first(),
  ).toBeVisible();
  await expect(settings.getByRole("group", { name: "Language", exact: true })).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "Español", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-es");

  await page.getByRole("option", { name: "Español", exact: true }).click();
  await expect(
    settings.getByRole("heading", { name: "General", exact: true }).first(),
  ).toBeVisible();
  await expect(settings.getByRole("group", { name: "Idioma", exact: true })).toBeVisible();
  await expect(picker).toHaveText("Español");
  await captureScreenshot(page, testInfo, "ui-locale-settings-es");
});

test("general settings language picker includes Russian and persists it", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `ui-locale-ru-${stamp}@example.test`, "password12", "Locale QA");
  await completeOnboarding(page, testInfo);

  await page.locator("header.app-drag").getByRole("button", { name: "Settings" }).click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-nav-general").click();
  await expect(settings).toBeVisible();

  const picker = settings.getByTestId("ui-locale-select");
  await picker.click();
  await expect(page.getByRole("option", { name: "Русский", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "ui-locale-picker-ru");

  await page.getByRole("option", { name: "Русский", exact: true }).click();
  await expect(settings.getByRole("heading", { name: "Общие", exact: true }).first()).toBeVisible();
  await expect(settings.getByRole("group", { name: "Язык", exact: true })).toBeVisible();
  await expect(picker).toHaveText("Русский");
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await expect(page.locator("html")).toHaveAttribute("dir", "ltr");
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("lang", "ru");
  await captureScreenshot(page, testInfo, "ui-locale-settings-ru");
});
