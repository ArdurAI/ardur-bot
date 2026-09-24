import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { bots, installPerformanceFixture } from "./performance-fixture";

test("desktop System controls use the native bridge and space Dispatch policy", async ({
  page,
}, testInfo) => {
  await installPerformanceFixture(page);
  let dispatch = true;
  await page.route("**/rpc/system/**", async (route) => {
    if (new URL(route.request().url()).pathname.endsWith("/setDispatch"))
      dispatch = route.request().postDataJSON().json.enabled;
    await route.fulfill({ json: { json: { enabled: dispatch, canChange: true } } });
  });
  await page.addInitScript(() => {
    let state = {
      version: "0.1.0-fixture",
      platform: "darwin",
      mode: "new",
      startupSupported: true,
      preferences: {
        runOnStartup: false,
        quickAccess: "Off",
        voice: "Off",
        dictation: "Off",
        menuBar: false,
        keepAwake: false,
        openLinksInBrowser: false,
      },
      awakeRoutines: 0,
      storage: { path: null, canMove: false, progress: null },
      permissions: { accessibility: "granted", screen: "not-determined" },
      shortcutError: false,
      shortcutOptions: {
        quickAccess: ["Off", "Alt+Space", "Control+Space"],
        voice: ["Off", "CommandOrControl+Shift+V", "Control+Space"],
        dictation: ["Off", "CommandOrControl+D", "CommandOrControl+Shift+D"],
      },
    };
    Object.defineProperty(window, "ardurbotDesktop", {
      value: {
        platform: "darwin",
        oauth: { onCallback: () => () => {} },
        window: {
          close: async () => {},
          minimize: async () => {},
          toggleMaximize: async () => {},
          state: async () => ({}),
        },
        system: {
          state: async () => state,
          set: async (key: string, value: unknown) => {
            if (key === "voice" && value === state.preferences.quickAccess && value !== "Off")
              throw new Error("That shortcut is already in use; choose another.");
            state = { ...state, preferences: { ...state.preferences, [key]: value } };
            return state;
          },
          onShortcut: () => () => {},
          openPermission: async (permission: string) => {
            document.documentElement.dataset.permission = permission;
          },
        },
      },
    });
  });
  await page.goto("/app");
  await page
    .getByTestId("bots-sidebar")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await page.getByTestId("settings-nav-system").click();
  const settings = page.getByTestId("user-settings");
  await expect(settings.getByText("Desktop app", { exact: true })).toBeVisible();
  await expect(settings.getByText("0.1.0-fixture")).toBeVisible();
  await settings.getByRole("switch", { name: "Run on startup", exact: true }).click();
  await expect(settings.getByRole("switch", { name: "Run on startup", exact: true })).toBeChecked();
  await settings.getByLabel("Quick access shortcut", { exact: true }).selectOption("Control+Space");
  await settings.getByLabel("Voice shortcut", { exact: true }).selectOption("Control+Space");
  await expect(settings.getByRole("alert")).toContainText(
    "That shortcut is already in use; choose another.",
  );
  await expect(settings.getByLabel("Voice shortcut", { exact: true })).toHaveValue("Off");
  await captureScreenshot(page, testInfo, "desktop-system-shortcuts");
  await settings.getByRole("switch", { name: "Dispatch", exact: true }).click();
  await expect(settings.getByRole("switch", { name: "Dispatch", exact: true })).not.toBeChecked();
  expect(dispatch).toBe(false);
  await expect(settings.getByRole("button", { name: "Change", exact: true })).toHaveCount(0);
  await settings.getByRole("button", { name: "Open Accessibility settings" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-permission", "accessibility");
  await captureScreenshot(page, testInfo, "desktop-system-browser-permissions");
});

test("System is absent from an ordinary web session", async ({ page }) => {
  await installPerformanceFixture(page);
  await page.goto("/app");
  await page
    .getByTestId("bots-sidebar")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  await expect(page.getByTestId("settings-nav-system")).toHaveCount(0);
});

test("quick access sends to the selected coordinator's normal thread", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 560, height: 240 });
  await installPerformanceFixture(page);
  await page.route("**/rpc/bots/list", (route) => route.fulfill({ json: { json: bots } }));
  let sent: unknown;
  await page.route("**/rpc/threads/send", async (route) => {
    sent = route.request().postDataJSON().json;
    expect(route.request().headers()["x-ardurbot-space-id"]).toBe("fixture-space");
    await route.fulfill({
      json: { json: { runId: "fixture-run", taskId: "fixture-task", seq: 101 } },
    });
  });
  await page.addInitScript(() => {
    let bot: string | null = null;
    Object.defineProperty(window, "ardurbotDesktop", {
      value: {
        platform: "darwin",
        system: {
          quickBot: async (_identity: unknown, id?: string) => {
            if (id) bot = id;
            return bot;
          },
          closeQuick: async () => {
            document.documentElement.dataset.quickClosed = "true";
          },
        },
      },
    });
  });
  await page.goto("/desktop/quick-access");
  await page.getByLabel("Coordinator bot").selectOption("fixture-bot-1");
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Review the task");
  await captureScreenshot(page, testInfo, "desktop-quick-access");
  await page.getByRole("textbox", { name: "Message", exact: true }).press("Enter");
  await expect(page.locator("html")).toHaveAttribute("data-quick-closed", "true");
  expect(sent).toMatchObject({
    botId: "fixture-bot-1",
    text: "Review the task",
    clientNonce: expect.any(String),
  });
});
