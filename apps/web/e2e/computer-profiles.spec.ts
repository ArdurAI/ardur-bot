import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openUserSettings,
  signup,
} from "./helpers";

test("computer profiles require confirmation before replacement", async ({ page }, testInfo) => {
  await signup(page, `profiles-${Date.now()}@ardurbot.test`, "password12", "Builder");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await page.route("**/rpc/computer/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            botId,
            name: "Builder",
            status: {
              botId,
              computerId: "computer",
              mode: "team",
              kind: "docker",
              state: "stopped",
              imageProfile: "base",
              connectionId: null,
              controlHolder: "none",
              controlBotId: null,
              takeoverRequested: false,
              screenAvailable: false,
              screenWidth: 1280,
              screenHeight: 800,
              homeRevision: "saved",
              busyBotName: null,
              canUpdate: true,
            },
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/computer/connections", (route) => route.fulfill({ json: { json: [] } }));
  let configured = 0;
  await page.route("**/rpc/computer/configure", (route) => {
    configured++;
    return route.fulfill({
      json: {
        json: {
          id: "update",
          botId,
          name: "Builder",
          mode: "team",
          action: "update",
          status: "queued",
          stage: "preparing",
        },
      },
    });
  });
  let engineRequests = 0;
  await page.route("**/rpc/computer/engine", (route) => {
    engineRequests++;
    return engineRequests === 1
      ? route.fulfill({
          status: 503,
          json: {
            json: {
              defined: false,
              code: "SERVICE_UNAVAILABLE",
              status: 503,
              message:
                "Docker is not running or not reachable at /fixture/docker.sock. Start Docker Desktop and try again.",
            },
          },
        })
      : route.fulfill({ json: { json: { name: "docker", rootless: false } } });
  });
  const settings = await openUserSettings(page);
  await settings.getByRole("button", { name: "Computers", exact: true }).click();
  await expect(
    settings.getByText(
      "Docker is not running or not reachable at /fixture/docker.sock. Start Docker Desktop and try again.",
    ),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "computer-engine-stopped");
  await settings.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(
    settings.getByText("Docker is not running or not reachable", { exact: false }),
  ).toHaveCount(0);
  expect(engineRequests).toBe(2);

  await page.getByLabel("Image profile", { exact: true }).selectOption("developer");
  await captureScreenshot(page, testInfo, "computer-image-profiles");
  await page.getByRole("button", { name: "Apply", exact: true }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("This replaces the computer's files. Continue?");
  await captureScreenshot(page, testInfo, "computer-profile-confirmation");
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(configured).toBe(0);
});
