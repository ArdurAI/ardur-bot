import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { installPerformanceFixture } from "./performance-fixture";

// A Docker server's owner, in an Electron client, has not chosen where bots run yet.
for (const platform of ["darwin", "win32"]) {
  test(`host computer choice explains file access on ${platform}`, async ({ page }, testInfo) => {
    await installPerformanceFixture(page, false, false, {
      sandboxProvider: "docker",
      canChooseHostComputer: true,
      computerHost: null,
    });
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
