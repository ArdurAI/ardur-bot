import { expect, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  openBotSettings,
  signup,
} from "./helpers";

test("adds linked board items to bot open work", async ({ page }, testInfo) => {
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, me: { ...body.json.me, isDeploymentOwner: true } } },
    });
  });

  await signup(page, `scratchpad-${Date.now()}@example.test`, "password12", "Builder");
  await completeOnboarding(page);
  const botId = activeBotId(page);

  await page.route("**/rpc/board/view", (route) =>
    route.fulfill({
      json: {
        json: {
          workspaces: [{ id: "ws-1", name: "Roadmap", enabled: true, allowAllBots: true, allowedBotIds: [] }],
          bots: [{ id: botId, name: "Builder" }]
        }
      }
    })
  );

  await page.route("**/rpc/board/snapshot", (route) =>
    route.fulfill({
      json: {
        json: {
          items: [{ id: "item-1", title: "Build feature X", status: "open", type: "task" }],
          readyIds: [],
          blockedIds: [],
          workspaces: []
        }
      }
    })
  );

  await openBotSettings(page);
  await page.getByRole("tab", { name: "Advanced" }).click();
  await page.getByRole("button", { name: "Memory" }).click();

  await page.getByRole("button", { name: "Add from board" }).click();
  await page.getByText("Build feature X").click();

  await page.route("**/rpc/scratchpad/linkBoardItems", (route) =>
    route.fulfill({ json: { json: [] } })
  );

  await page.getByRole("dialog").getByRole("button", { name: "Add" }).click();

  await captureScreenshot(page, testInfo, "scratchpad-board-linked");
});
