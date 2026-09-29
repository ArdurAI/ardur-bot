import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("offers Manage and says to enable a server first when its sign-in card is authorized while disabled", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-approval-card-${stamp}@example.test`, "password12", "Approval Card");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("propose an mcp server named Disabled Reports Server");
  await page.keyboard.press("Enter");

  const card = page.getByText("Connect MCP server “Disabled Reports Server”", {
    exact: true,
  });
  await expect(card).toBeVisible({ timeout: 20_000 });

  await openUserSettings(page, "integrations");
  await page.getByTestId("settings-nav-mcp").click();
  await expect(page.getByRole("heading", { name: "MCP", exact: true })).toBeVisible();
  const serverCard = page.locator('[id^="mcp-server-"]', { hasText: "Disabled Reports Server" });
  await expect(serverCard).toBeVisible();
  await serverCard.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(serverCard.getByRole("button", { name: "Enable", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close user settings" }).click();

  await page.getByRole("button", { name: "Authorize", exact: true }).click();
  await expect(page.getByText("Enable this server first, then sign in.")).toBeVisible();
  const manage = page.getByRole("button", { name: "Manage", exact: true });
  await expect(manage).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-approval-card-disabled");

  await manage.click();
  await expect(page.getByRole("heading", { name: "MCP", exact: true })).toBeVisible();
  await expect(page.getByText("Disabled Reports Server", { exact: true })).toBeVisible();
});
