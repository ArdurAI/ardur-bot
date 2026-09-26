import type { Me } from "@ardurbot/contracts";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { installPerformanceFixture } from "./performance-fixture";

/** Opens the app as the desktop app would, with the host choice the API reports. */
async function openDesktopApp(
  page: Page,
  platform: string,
  choice: Pick<Me, "sandboxProvider" | "canChooseHostComputer" | "computerHost">,
) {
  await installPerformanceFixture(page, false, false, choice);
  await page.addInitScript((platform) => {
    Object.defineProperty(window, "ardurbotDesktop", {
      value: {
        platform,
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({ minimized: false, maximized: false, fullScreen: false }),
        },
        oauth: { onCallback: () => () => {} },
        update: {
          state: async () => ({ phase: "idle", currentVersion: "0.1.0" }),
        },
      },
    });
  }, platform);
  await page.goto("/app");
  await expect(
    page.getByRole("banner").getByRole("button", { name: "Settings", exact: true }),
  ).toBeVisible();
}

for (const [shape, choice] of [
  [
    "local mode",
    { sandboxProvider: "desktop", canChooseHostComputer: false, computerHost: "this-mac" },
  ],
  [
    "its own Compose stack",
    { sandboxProvider: "docker", canChooseHostComputer: false, computerHost: "this-mac" },
  ],
] as const) {
  test(`the desktop app never asks where bots run in ${shape}`, async ({ page }) => {
    await openDesktopApp(page, "darwin", choice);
    await expect(page.getByRole("dialog", { name: "Where should bots run?" })).toHaveCount(0);
    await expect(page.getByText("Local access lets bots run commands without asking.")).toHaveCount(
      0,
    );
  });
}

for (const platform of ["darwin", "win32"]) {
  test(`a Docker server's owner still chooses, with the warning, on ${platform}`, async ({
    page,
  }, testInfo) => {
    await openDesktopApp(page, platform, {
      sandboxProvider: "docker",
      canChooseHostComputer: true,
      computerHost: null,
    });
    const dialog = page.getByRole("dialog", { name: "Where should bots run?" });
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAccessibleDescription(
      /Local access lets bots run commands without asking\. Avoid it on shared or public servers\./,
    );
    const host = platform === "darwin" ? "this Mac" : "this computer";
    await expect(
      dialog.getByText(
        `Docker limits access to your computer for added security. Using ${host} lets bots work with your local files and tools.`,
      ),
    ).toBeVisible();
    await expect(
      dialog.getByText(
        "Local access lets bots run commands without asking. Avoid it on shared or public servers.",
      ),
    ).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Docker", exact: true })).toBeVisible();
    await expect(dialog.getByText(/recommended/i)).toHaveCount(0);
    await expect(dialog.getByRole("button", { name: `Use ${host}` })).toBeVisible();
    await captureScreenshot(page, testInfo, `host-computer-choice-${platform}`);
  });
}
