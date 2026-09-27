import type { ComputerStatus } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

test("Terminal is optional, keeps Screen default and exposes a clear unavailable state", async ({
  page,
}, testInfo) => {
  await signup(page, `terminal-${Date.now()}@ardurbot.test`, "password12", "Terminal");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await page.route("**/rpc/terminal/available", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { available: false } }),
    }),
  );
  await page.getByPlaceholder(/Message/).fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");
  const card = page.getByTestId("computer-card");
  await expect(card).toBeVisible({ timeout: 30_000 });
  await card.getByTestId("computer-card-open").click();
  await expect(page.getByRole("tab", { name: "Screen", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await page.getByRole("tab", { name: "Terminal", exact: true }).click();
  await expect(
    page.getByText("Terminal is not available on this computer", { exact: true }),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "terminal-unavailable");
  await page.getByRole("button", { name: "Back to screen" }).click();
  await expect(page.getByRole("tab", { name: "Screen", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  expect(botId).toBeTruthy();
});

test("Terminal loads on demand and shell shortcuts stay in the terminal", async ({
  page,
}, testInfo) => {
  await signup(page, `terminal-input-${Date.now()}@ardurbot.test`, "password12", "Terminal Input");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  const computer: ComputerStatus = {
    computerId: "terminal-computer",
    botId,
    mode: "team",
    kind: "docker",
    state: "running",
    controlHolder: "user",
    controlBotId: botId,
    takeoverRequested: false,
    screenAvailable: true,
    screenWidth: 1024,
    screenHeight: 768,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
  };
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const value = await response.json();
    if (value.json?.thread) value.json.thread.computer = computer;
    await route.fulfill({ response, json: value });
  });
  await page.route("**/rpc/terminal/available", (route) =>
    route.fulfill({ json: { json: { available: true } } }),
  );
  await page.route("**/rpc/terminal/ticket", (route) =>
    route.fulfill({
      json: {
        json: {
          sessionId: "terminal-session",
          ticket: crypto.randomUUID(),
          path: "/api/terminal/socket",
        },
      },
    }),
  );
  await page.route("**/rpc/terminal/close", (route) =>
    route.fulfill({ json: { json: { ok: true } } }),
  );
  await page.routeWebSocket("**/api/terminal/socket", (socket) => {
    socket.onMessage((message) => {
      if (typeof message === "string" && JSON.parse(message).type === "connect")
        socket.send(JSON.stringify({ type: "ready", inputSeq: 0 }));
    });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await page.locator("body").click();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByRole("option", { name: "Open terminal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Terminal", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
  await captureScreenshot(page, testInfo, "terminal-tab");
});
