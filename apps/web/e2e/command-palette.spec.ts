import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("command palette opens with keyboard, filters, and switches bots", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `cmdk-bots-${stamp}@ardurbot.test`, "password12", "CmdK Bots");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);

  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "research lead",
    description: "Finds sources and writes briefs.",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await page.reload();
  await page.waitForURL(/\/app\/[^/]+$/);
  await expect(
    page
      .locator("aside")
      .first()
      .getByRole("button", { name: /^Researcher/ }),
  ).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  const palette = page.getByTestId("command-palette");
  const dialog = page.getByRole("dialog", { name: "Switch bot" });
  await expect(dialog).toBeVisible();
  await expect(palette).toBeVisible();
  await expect(page.getByRole("tab")).toHaveCount(0);
  await expect(page.getByRole("option", { name: /Chief/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Researcher/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "command-palette-bots");

  const search = page.getByTestId("command-palette-search");
  await search.fill("Research");
  await expect(page.getByRole("option", { name: /Researcher/ })).toBeVisible();
  await expect(page.getByRole("option", { name: /Chief/ })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "command-palette-filtered");

  await page.getByRole("option", { name: /Researcher/ }).click();
  await expect(dialog).toBeHidden();
  await page.waitForURL(new RegExp(`/app/${researcher.id}$`));
  expect(activeBotId(page)).toBe(researcher.id);
  await expect(page.getByRole("combobox", { name: "Message Researcher" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  await expect(dialog).toBeVisible();
  await page.getByTestId(`command-palette-bot-${chiefId}`).click();
  await page.waitForURL(new RegExp(`/app/${chiefId}$`));
  expect(activeBotId(page)).toBe(chiefId);
});

test("daily shortcuts run from the keyboard and show in the palette", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `shortcuts-${stamp}@ardurbot.test`, "password12", "Shortcut Keys");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);
  const chiefId = activeBotId(page);
  const researcher = await rpc<{ id: string }>(page, "bots/create", {
    name: "Researcher",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
    computerMode: "team",
  });
  await page.reload();
  await page.waitForURL(new RegExp(`/app/${chiefId}$`));
  const sidebar = page.getByTestId("bots-sidebar");
  const researcherRow = sidebar.getByRole("button", { name: /^Researcher/ });
  await expect(researcherRow).toBeVisible();

  const composer = page.locator('textarea[name="chat-message"]');
  await page.keyboard.press("ControlOrMeta+Shift+M");
  await expect(composer).toBeFocused();
  // Plain keys stay text, and Back leaves the draft where it is.
  await page.keyboard.type("b[,");
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await expect(composer).toHaveValue("b[,");
  expect(activeBotId(page)).toBe(chiefId);

  await page.keyboard.press("ControlOrMeta+F");
  await expect(page.getByTestId("sidebar-search").locator("input")).toBeFocused();
  await page.keyboard.press("ControlOrMeta+B");
  await expect(sidebar).toHaveAttribute("data-collapsed", "true");
  await page.keyboard.press("ControlOrMeta+B");
  await expect(sidebar).toHaveAttribute("data-collapsed", "false");

  await researcherRow.click();
  await page.waitForURL(new RegExp(`/app/${researcher.id}$`));
  await page.keyboard.press("ControlOrMeta+BracketLeft");
  await page.waitForURL(new RegExp(`/app/${chiefId}$`));
  await page.keyboard.press("ControlOrMeta+BracketRight");
  await page.waitForURL(new RegExp(`/app/${researcher.id}$`));

  await page.keyboard.press("ControlOrMeta+Shift+O");
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "create");
  await expect(page.getByTestId("create-bot-form")).toBeVisible();

  await page.keyboard.press("ControlOrMeta+K");
  const dialog = page.getByRole("dialog", { name: "Switch bot" });
  await expect(dialog).toBeVisible();
  const settings = page.getByTestId("command-palette-action-settings");
  await expect(settings).toContainText(/(⌘|Ctrl\+),/);
  await expect(page.getByTestId("command-palette-action-newBot")).toContainText(
    /(⇧⌘|Ctrl\+Shift\+)O/,
  );
  await page
    .getByTestId("command-palette-list")
    .evaluate((list) => list.scrollTo({ top: list.scrollHeight }));
  await captureScreenshot(page, testInfo, "command-palette-shortcuts");

  await page.getByTestId("command-palette-search").fill("sett");
  await expect(page.getByTestId("command-palette-action-newBot")).toHaveCount(0);
  await settings.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("user-settings")).toBeVisible();
});
