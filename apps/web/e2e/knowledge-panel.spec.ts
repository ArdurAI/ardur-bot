import type { MemoryPage } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  rpc,
  signup,
} from "./helpers";

test("memory and skills are readable and editable in the app", async ({ page }, testInfo) => {
  const stamp = Date.now();
  const userName = `Knowledge ${stamp}`;
  await signup(page, `knowledge-${stamp}@example.test`, "password12", userName);
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);

  // Shared memory is presented as topics in Settings; bot documents retain
  // their explicit editor under the bot's Knowledge section.
  await openUserSettings(page, "memory");
  await expect(page.getByLabel("Close memory settings")).toBeVisible();
  const memory = page.getByTestId("memory-settings-page");
  await expect(memory.getByRole("group", { name: "Topics" })).toBeVisible();
  const memoryRow = memory.getByRole("button", { name: /Space memory/ });
  await expect(memoryRow).toBeVisible();
  await memoryRow.click();
  const sharedDocument = memory.getByRole("region", { name: "Memory document" });
  await expect(sharedDocument.getByRole("heading", { name: "Space memory" })).toBeVisible();
  await expect(sharedDocument).toContainText(
    "Preferences and context kept within this space live here.",
  );
  await sharedDocument.getByText("History", { exact: true }).click();
  await expect(sharedDocument.getByRole("button", { name: /^Revision 1/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "83-space-memory-topic");
  await page.getByLabel("Close memory settings").click();
  await expect(page.getByLabel("Close memory settings")).toHaveCount(0);

  // The bot's Knowledge section lives under Advanced in its settings panel.
  await page
    .locator("main")
    .getByRole("button", { name: /^Chief/ })
    .click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeVisible();
  await settings.getByText("Advanced", { exact: true }).click();
  const knowledge = settings.getByTestId("bot-knowledge");
  await expect(knowledge).toBeVisible();
  await expect(knowledge.getByRole("tablist", { name: "Knowledge" })).toBeVisible();

  // Bot creation seeds MEMORY.md (`# Chief`); edit it and assert the revision bumps.
  const botMemory = knowledge.getByTestId("bot-knowledge-memory");
  const botMemoryRow = botMemory.getByRole("button", { name: /MEMORY\.md/ });
  await expect(botMemoryRow).toBeVisible();
  await botMemoryRow.click();
  const botDocEditor = botMemory.locator("textarea");
  await expect(botDocEditor).toHaveValue(/# Chief/);
  const botMarker = `Bot memory e2e ${stamp}`;
  await botDocEditor.fill(`# Chief\n\n${botMarker}\n`);
  await botMemory.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "80-knowledge-bot-memory");
  await botMemory.getByRole("button", { name: "Save", exact: true }).click();
  await expect(botMemory.getByText("rev 2")).toBeVisible();
  expect(
    (
      await rpc<MemoryPage>(page, "memory/list", {
        botId: activeBotId(page),
        scope: "bot",
      })
    ).items,
  ).toContainEqual(expect.objectContaining({ content: `# Chief\n\n${botMarker}\n`, revision: 2 }));
  await botMemoryRow.click();
  await expect(botDocEditor).toHaveValue(new RegExp(botMarker));
  await botMemory.getByRole("button", { name: "Cancel", exact: true }).click();

  // Skills: create one through the editor, reopen it, edit, then delete it.
  // Builtin catalog is currently empty; user skills still cover create/edit/delete.
  await knowledge.getByRole("tab", { name: "Skills", exact: true }).click();
  await knowledge.getByRole("button", { name: "New skill", exact: true }).click();
  const editor = knowledge.locator("textarea");
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Always open with a greeting.",
    ].join("\n"),
  );
  await captureScreenshot(page, testInfo, "81-knowledge-skill-editor");
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  const skillRow = knowledge.getByRole("button", { name: /greet-politely/ });
  await expect(skillRow).toBeVisible();
  await expect(knowledge.getByText("Say hello before anything else.")).toBeVisible();
  await captureScreenshot(page, testInfo, "82-knowledge-skill-listed");
  const composer = page.getByRole("combobox", { name: /^Message/ });
  await composer.fill("/");
  await expect(page.getByRole("option", { name: /\/greet-politely/ })).toBeVisible();
  await composer.fill("");

  // A provider-owned skill uses the same viewer without mutation controls.
  await page.route(
    "**/rpc/agentSkills/get",
    async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({
        response,
        json: { ...body, json: { ...body.json, readOnly: true, source: "plugin" } },
      });
    },
    { times: 1 },
  );
  await skillRow.click();
  await expect(editor).toHaveAttribute("readonly", "");
  await expect(knowledge.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  await expect(knowledge.getByRole("button", { name: "Delete", exact: true })).toHaveCount(0);
  await knowledge.getByRole("button", { name: "Close", exact: true }).click();
  await skillRow.click();
  await expect(editor).toHaveValue(/Always open with a greeting/);
  await editor.fill(
    [
      "---",
      "name: greet-politely",
      "description: Say hello before anything else.",
      "---",
      "",
      "Open with a warm greeting.",
    ].join("\n"),
  );
  let releaseSkillRefresh!: () => void;
  const skillRefreshGate = new Promise<void>((resolve) => {
    releaseSkillRefresh = resolve;
  });
  await page.route(
    "**/rpc/agentSkills/list",
    async (route) => {
      await skillRefreshGate;
      await route.continue();
    },
    { times: 1 },
  );
  await knowledge.getByRole("button", { name: "Save", exact: true }).click();
  try {
    await expect(editor).toBeHidden();
    await expect(skillRow).toBeDisabled();
    await captureScreenshot(page, testInfo, "85-skill-refresh-pending");
  } finally {
    releaseSkillRefresh();
  }
  await skillRow.click();
  await expect(editor).toHaveValue(/warm greeting/);
  await knowledge.getByRole("button", { name: "Delete", exact: true }).click();
  await knowledge.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect(skillRow).toBeHidden();
  await composer.fill("/");
  await expect(page.getByRole("option", { name: /\/greet-politely/ })).toHaveCount(0);
  expect(await rpc<Array<{ name: string }>>(page, "agentSkills/list", {})).not.toContainEqual(
    expect.objectContaining({ name: "greet-politely" }),
  );
});
