import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("composer / picker lists skills above actions", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `slash-skills-${stamp}@example.test`, "password12", "Slash Skills");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);

  await rpc(page, "agentSkills/create", {
    name: "Daily standup",
    description:
      "Prepare a concise standup update from recent work. Use when the user asks for standup notes.",
    body: "1. Summarize wins.\n2. List blockers.",
  });
  // The shell loads the skill catalog on mount; reload to observe the new skill.
  await page.reload();
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);

  // aria-label stays available when skill/mention chips hide the placeholder.
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await expect(composer).toBeVisible();
  await composer.fill("/");

  const picker = page.getByTestId("slash-picker");
  await expect(picker).toBeVisible();
  const skillButton = picker.getByRole("option", { name: /Daily standup/ });
  const chatSettings = picker.getByRole("option", { name: /Chat Settings/ });
  await expect(skillButton).toBeVisible();
  await expect(chatSettings).toBeVisible();
  await expect(picker.getByRole("option", { name: /Settings: General/ })).toBeVisible();
  await expect(picker.getByRole("option", { name: /Settings: Usage/ })).toBeVisible();

  const skillBox = await skillButton.boundingBox();
  const actionBox = await chatSettings.boundingBox();
  expect(skillBox).toBeTruthy();
  expect(actionBox).toBeTruthy();
  expect(skillBox!.y).toBeGreaterThan(actionBox!.y);

  await expect(skillButton).toContainText("Prepare a concise standup");
  const interrogate = picker.getByRole("option", { name: /Interrogate/ });
  await expect(interrogate).toBeVisible();
  await expect(interrogate).toContainText("Review only; never applies fixes.");
  await captureScreenshot(page, testInfo, "slash-skills-picker");

  await skillButton.click();
  await expect(page.getByTestId("slash-picker")).toHaveCount(0);
  const skillChip = page.getByTestId("skill-chip");
  await expect(skillChip).toBeVisible();
  await expect(skillChip).toContainText("Daily standup");
  await expect(composer).toHaveValue("");
  await composer.fill("focus on blockers");
  await captureScreenshot(page, testInfo, "slash-skills-inserted");

  await composer.fill("hello /");
  await expect(page.getByTestId("slash-picker")).toHaveCount(0);

  await page.getByRole("button", { name: "Remove skill Daily standup" }).click();
  await expect(page.getByTestId("skill-chip")).toHaveCount(0);

  await composer.fill("/Inter");
  await expect(interrogate).toBeVisible();
  await captureScreenshot(page, testInfo, "interrogate-skill-picker");
  await interrogate.click();
  await expect(skillChip).toContainText("Interrogate");
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Remove skill Interrogate" }).click();

  await composer.fill("@");
  await expect(page.getByTestId("slash-picker")).toHaveCount(0);
});
