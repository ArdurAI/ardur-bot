import type { ComputerStatus } from "@ardurbot/contracts";
import { encodeTerminalFrame } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";
import { bots, installPerformanceFixture } from "./performance-fixture";
import { openAgentComputer, openWorkspaceView } from "./workspace-view";

test("Terminal is optional, keeps Screen default and exposes a clear unavailable state", async ({
  page,
}, testInfo) => {
  await signup(page, `terminal-${Date.now()}@example.test`, "password12", "Terminal");
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
  context,
}, testInfo) => {
  await signup(page, `terminal-input-${Date.now()}@example.test`, "password12", "Terminal Input");
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
      if (typeof message === "string" && JSON.parse(message).type === "connect") {
        socket.send(JSON.stringify({ type: "ready", inputSeq: 0 }));
        socket.send(
          Buffer.from(
            encodeTerminalFrame(1, new TextEncoder().encode("https://example.test/\r\n")),
          ),
        );
      }
    });
  });
  await page.reload();
  await expect(page.getByRole("button", { name: "Search", exact: true })).toBeVisible();
  await page.locator("body").click();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.getByTestId("command-palette")).toBeVisible();
  await page.getByRole("option", { name: "Open terminal", exact: true }).click();
  await expect(page.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
  const printed = page.getByText("https://example.test/", { exact: true }).first();
  await expect(printed).toBeVisible();
  expect(context.pages()).toHaveLength(1);
  await context.route("https://example.test/**", (route) =>
    route.fulfill({ body: "Fixture page" }),
  );
  let printedBounds: Awaited<ReturnType<typeof printed.boundingBox>> = null;
  await expect
    .poll(async () => {
      printedBounds = await printed.boundingBox();
      return printedBounds;
    })
    .not.toBeNull();
  // Accessibility text sits beneath xterm's screen; move the real pointer over the glyphs.
  await page.mouse.move(
    printedBounds!.x + printedBounds!.width / 2,
    printedBounds!.y + printedBounds!.height / 2,
  );
  await expect(page.getByRole("button", { name: "Open link", exact: true })).toBeVisible();
  const popup = context.waitForEvent("page");
  await page.getByRole("button", { name: "Open link", exact: true }).click();
  const opened = await popup;
  await expect(opened).toHaveURL("https://example.test/");
  await opened.close();
  await page.bringToFront();
  await page.getByRole("textbox", { name: "Terminal", exact: true }).focus();
  await page.keyboard.press("ControlOrMeta+K");
  await expect(page.getByTestId("command-palette")).toBeHidden();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("computer-viewport")).toBeVisible();
  await captureScreenshot(page, testInfo, "terminal-tab");
});

test("workspace keeps four distinct terminals and releases only at the final close", async ({
  page,
}, testInfo) => {
  const botId = bots[0]!.id;
  const computer: ComputerStatus = {
    botId,
    computerId: "tabs-computer",
    computerGeneration: 1,
    mode: "team",
    kind: "docker",
    state: "running",
    controlHolder: "user",
    controlBotId: botId,
    capabilities: { graphical: false, interactiveTerminal: true },
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: null,
    busyBotName: null,
    canUpdate: false,
  };
  await installPerformanceFixture(page, false, false, {}, computer);
  let opened = 0,
    releases = 0;
  const closed: string[] = [];
  await page.route("**/rpc/terminal/available", (route) =>
    route.fulfill({ json: { json: { available: true } } }),
  );
  await page.route("**/rpc/terminal/ticket", (route) => {
    const sessionId = route.request().postDataJSON().json.sessionId ?? `tabs-${++opened}`;
    return route.fulfill({
      json: { json: { sessionId, ticket: sessionId, path: "/api/terminal/socket" } },
    });
  });
  await page.route("**/rpc/terminal/close", (route) => {
    closed.push(route.request().postDataJSON().json.sessionId);
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.route("**/rpc/computer/release", (route) => {
    releases++;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.routeWebSocket("**/api/terminal/socket", (socket) => {
    socket.onMessage((message) => {
      if (typeof message !== "string") return;
      const payload = JSON.parse(message);
      if (payload.type === "connect") {
        socket.send(
          JSON.stringify({
            type: "ready",
            version: 2,
            inputSeq: 0,
            reset: payload.reset === true,
            from: 1,
            truncated: false,
            cols: 80,
            rows: 24,
          }),
        );
        socket.send(
          JSON.stringify({ type: "replay-size", version: 2, seq: 1, cols: 80, rows: 24 }),
        );
        socket.send(
          Buffer.from(
            encodeTerminalFrame(1, new TextEncoder().encode(`Process ${payload.ticket}\r\n`)),
          ),
        );
        socket.send(
          JSON.stringify({ type: "replay-size", version: 2, seq: 2, cols: 40, rows: 12 }),
        );
        socket.send(
          Buffer.from(encodeTerminalFrame(2, new TextEncoder().encode("After resize\r\n"))),
        );
        socket.send(JSON.stringify({ type: "replay-end", version: 2, seq: 2 }));
      }
    });
  });
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await openAgentComputer(page);
  await openWorkspaceView(page, "Terminal");
  const pane = page.getByTestId("side-panel");
  for (const number of [1, 2, 3, 4]) {
    if (number > 1) await pane.getByRole("button", { name: "New terminal", exact: true }).click();
    await expect(pane.locator(".xterm-accessibility-tree:visible")).toContainText(
      `Process tabs-${number}`,
    );
  }
  await expect(pane.getByRole("button", { name: "New terminal", exact: true })).toBeDisabled();
  expect(opened).toBe(4);
  await pane.getByRole("tab", { name: "Terminal 1", exact: true }).click();
  await expect(pane.locator(".xterm-accessibility-tree:visible")).toContainText("Process tabs-1");
  await captureScreenshot(page, testInfo, "workspace-four-terminals");
  await page.reload();
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await expect(pane.getByRole("tab", { name: "Terminal 1", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
  await expect(pane.locator(".xterm-accessibility-tree:visible")).toContainText("Process tabs-1");
  await expect(pane.locator(".xterm-accessibility-tree:visible")).toContainText("After resize");
  expect(opened).toBe(4);
  expect(closed).toEqual([]);
  expect(releases).toBe(0);
  await captureScreenshot(page, testInfo, "workspace-restored-terminals");
  await pane.getByRole("button", { name: "Close terminal", exact: true }).nth(1).click();
  await expect(pane.getByRole("tab", { name: "Terminal 2", exact: true })).toHaveCount(0);
  expect(releases).toBe(0);
  expect(new Set(closed)).toEqual(new Set(["tabs-2"]));
  await expect(pane.locator(".xterm-accessibility-tree:visible")).toContainText("Process tabs-1");
  await pane.getByRole("button", { name: "Close terminal", exact: true }).nth(1).click();
  await expect(pane.getByRole("tab", { name: "Terminal 3", exact: true })).toHaveCount(0);
  await pane.getByRole("button", { name: "Close terminal", exact: true }).nth(1).click();
  await expect(pane.getByRole("tab", { name: "Terminal 4", exact: true })).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("End this terminal?");
    await dialog.accept();
  });
  await pane.getByRole("button", { name: "Close terminal", exact: true }).click();
  await expect.poll(() => releases).toBe(1);
});
