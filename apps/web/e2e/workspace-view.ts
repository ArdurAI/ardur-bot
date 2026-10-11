import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Ensure the Views dropdown menu is open before interacting with its items. */
async function openViewsMenu(page: Page) {
  const trigger = page.locator("[data-workspace-trigger]");
  const menu = page.getByRole("menu");
  await expect(async () => {
    if (!(await menu.isVisible())) {
      await trigger.click();
    }
    await expect(menu).toBeVisible({ timeout: 1_000 });
    await expect(trigger).toHaveAttribute("aria-expanded", "true", { timeout: 1_000 });
  }).toPass({ intervals: [100, 250, 500], timeout: 5_000 });
}

/** Open a registered workspace view; unopened views are not tabs yet. */
export async function openWorkspaceView(page: Page, name: string) {
  const pane = page.getByTestId("side-panel");
  const tab = pane.getByRole("tab", { name, exact: true });
  await openAgentComputer(page);
  // The pane can be open before its lazy tab bar mounts. Retained tabs may also
  // be absent from the menu when their computer capability is unavailable.
  await expect(pane.getByRole("tablist").first()).toBeVisible();
  if (!(await tab.isVisible())) {
    await openViewsMenu(page);
    const item = page.getByRole("menuitemcheckbox", { name, exact: true });
    await expect(item).toHaveAttribute("aria-checked", /^(true|false)$/);
    // Clicking the active view returns to chat instead of opening it.
    if ((await item.getAttribute("aria-checked")) === "true") await page.keyboard.press("Escape");
    else await item.click();
  }
  await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return tab;
}

async function setAgentComputerOpen(page: Page, open: boolean) {
  await openViewsMenu(page);
  const item = page.locator("[data-workspace-toggle]");
  await expect(item).toHaveAttribute("aria-checked", /^(true|false)$/);
  if ((await item.getAttribute("aria-checked")) === String(open)) {
    await page.keyboard.press("Escape");
    if (!open) return;
  } else await item.click();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("aria-hidden", String(!open));
}

/** Open the remembered workspace without closing a pane restored after reload. */
export async function openAgentComputer(page: Page) {
  await setAgentComputerOpen(page, true);
}

/** Close explicitly when a journey needs to reopen and refresh the computer. */
export async function closeAgentComputer(page: Page) {
  await setAgentComputerOpen(page, false);
}
