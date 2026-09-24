import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("settings shell is two-pane and deep-links Models Memory Voice Usage", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Settings shell ${stamp}`;
  await signup(page, `settings-shell-${stamp}@ardurbot.test`, "password12", userName);
  await completeOnboarding(page);

  await page.getByTestId("user-menu-trigger").click();
  const menu = page.locator('[data-slot="popover-content"]');
  await expect(menu.getByRole("button", { name: "Settings", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Usage", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Log out", exact: true })).toBeVisible();
  await expect(menu.getByRole("button", { name: "Models", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-account-menu-lean");
  await page.keyboard.press("Escape");

  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  for (const [name, href] of [
    ["Report an issue", "https://github.com/ArdurAI/ardur-bot/issues/new/choose"],
    ["Discussions", "https://github.com/ArdurAI/ardur-bot/discussions"],
  ]) {
    const link = settings.getByRole("link", { name, exact: true });
    await expect(link).toHaveAttribute("href", href!);
    await expect(link).toHaveAttribute("target", "_blank");
  }
  await page.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).not.toBeVisible();
  await page.keyboard.press("Control+,");
  await expect(settings).toBeVisible();
  await page.getByRole("button", { name: "Close user settings" }).click();
  await expect(settings).not.toBeVisible();
  await page.keyboard.press("Meta+,");
  await expect(settings).toBeVisible();
  await expect(settings.getByTestId("settings-nav")).toBeVisible();
  await expect(settings.getByTestId("settings-nav-general")).toHaveAttribute(
    "aria-current",
    "page",
  );
  await expect(settings.getByRole("heading", { name: "General", exact: true })).toBeVisible();
  await expect(settings.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-general");

  await settings.getByTestId("settings-nav-models").click();
  await expect(settings).toHaveAttribute("data-settings-section", "models");
  await expect(settings.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(settings.getByTestId("model-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-models");

  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings).toHaveAttribute("data-settings-section", "memory");
  await expect(settings.getByRole("heading", { name: "Memory", exact: true })).toBeVisible();
  await expect(settings.getByTestId("memory-settings-page")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory");
  await settings.getByTestId("settings-nav-customize").click();
  await expect(settings).toHaveAttribute("data-settings-section", "customize");
  await expect(settings.getByTestId("memory-settings")).toBeVisible();
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByLabel("Memory location")).toHaveValue("postgres");
  await expect(memory.getByRole("tab", { name: "Documents", exact: true })).toBeVisible();
  await expect(memory.getByRole("tab", { name: "Skills", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-memory-documents");
  await memory.getByLabel("Memory location").selectOption("obsidian");
  await expect(memory.getByLabel("Memory folder on your server")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-memory-obsidian");
  await memory.getByLabel("Memory location").selectOption("git");
  await expect(memory.getByLabel("Repository URL")).toBeVisible();
  await expect(memory.getByLabel("Repository token", { exact: true })).toBeVisible();
  await memory.getByLabel("Publication mode").selectOption("propose");
  await expect(memory.getByRole("button", { name: "Test connection and preview" })).toBeDisabled();
  await captureScreenshot(page, testInfo, "settings-memory-git");
  await memory.getByLabel("Memory location").selectOption("service");
  await memory.getByLabel("Memory service").selectOption("mem0");
  await expect(memory.getByText("Sends memory text to api.mem0.ai", { exact: true })).toBeVisible();
  await expect(memory.getByLabel("API key", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-memory-mem0-platform");
  await memory.getByLabel("Memory service").selectOption("mem0-oss");
  await memory.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:8000");
  await expect(
    memory.getByText("Sends memory text to 127.0.0.1:8000", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-memory-mem0-oss");
  await memory.getByLabel("Memory service").selectOption("graphiti");
  await memory.getByLabel("Base URL", { exact: true }).fill("http://127.0.0.1:8001");
  await expect(memory.getByLabel("Bearer token (optional)")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Test connection", exact: true })).toBeEnabled();
  await captureScreenshot(page, testInfo, "settings-memory-graphiti");
  await memory.getByLabel("Memory service").selectOption("serenity");
  await expect(memory.getByLabel("MCP endpoint")).toBeVisible();
  await expect(memory.getByLabel("Bearer token")).toBeVisible();
  await expect(memory.getByRole("button", { name: "Recall only" })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-memory-serenity");

  await settings.getByTestId("settings-nav-voice").click();
  await expect(settings).toHaveAttribute("data-settings-section", "voice");
  await expect(settings.getByRole("heading", { name: "Voice", exact: true })).toBeVisible();
  await expect(settings.getByTestId("voice-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-voice");

  await page.getByRole("button", { name: "Close voice settings" }).click();
  await expect(page.getByTestId("user-settings")).toHaveCount(0);

  await openUserSettings(page, "usage");
  await expect(page.getByTestId("user-settings")).toHaveAttribute("data-settings-section", "usage");
  await expect(page.getByTestId("usage-settings")).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-shell-usage");
});
