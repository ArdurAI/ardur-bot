import type { Page } from "@playwright/test";
import { expect } from "@playwright/test";

/** Open a registered workspace view; unopened views are not tabs yet. */
export async function openWorkspaceView(page: Page, name: string) {
  const pane = page.getByTestId("side-panel");
  const tab = pane.getByRole("tab", { name, exact: true });
  if ((await pane.getAttribute("aria-hidden")) === "true" || !(await tab.isVisible())) {
    await page.getByRole("button", { name: "Views", exact: true }).click();
    await page.getByRole("menuitemcheckbox", { name, exact: true }).click();
  } else await tab.click();
  await expect(tab).toHaveAttribute("aria-selected", "true");
  return tab;
}

/** Toggle the remembered workspace and refresh its computer on reopening. */
export async function toggleAgentComputer(page: Page) {
  await page.getByRole("button", { name: "Views", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Agent computer", exact: true }).click();
}
