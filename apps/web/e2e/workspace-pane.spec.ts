import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { bots, installPerformanceFixture } from "./performance-fixture";

test("workspace pane opens Tasks and bot files without starting the computer", async ({
  page,
}, testInfo) => {
  const botId = bots[0]!.id;
  const computer = {
    botId,
    computerId: "fixture-computer",
    mode: "team",
    kind: "kubernetes",
    state: "running",
    capabilities: { graphical: false, interactiveTerminal: false },
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: "saved",
    busyBotName: null,
    canUpdate: false,
  };
  const context = {
    botId,
    computerId: "fixture-computer",
    generation: 1,
    files: "live",
    observedAt: "2026-09-28T00:00:00.000Z",
  };
  await installPerformanceFixture(page, false, false, {}, computer);
  const run = {
    runId: "fixture-run",
    botId,
    botName: bots[0]!.name,
    groupId: null,
    groupName: null,
    threadId: bots[0]!.threadId,
    coordinatorThreadId: null,
    status: "running",
    trigger: "user",
    notificationsEnabled: false,
    promptSnippet: "Review the workspace",
    updatedAt: "2026-09-28T00:00:00.000Z",
    startedAt: "2026-09-28T00:00:00.000Z",
  };
  const unexpected: string[] = [];
  await page.route("**/rpc/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(5);
    if (
      ["computer/boot", "computer/screenUrl", "computer/takeover", "terminal/ticket"].includes(name)
    )
      unexpected.push(name);
    const result =
      name === "workspace/describe"
        ? context
        : name === "workspace/tasks"
          ? { runs: [run], delegations: [], routines: [], observedAt: context.observedAt }
          : name === "workspace/list"
            ? { context, entries: [{ path: "notes.md", kind: "file", size: 17 }] }
            : name === "workspace/read"
              ? { context, path: "notes.md", content: "Workspace notes\n" }
              : undefined;
    if (result !== undefined) await route.fulfill({ json: { json: result } });
    else await route.fallback();
  });
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Agent computer" }).click();
  const pane = page.getByTestId("side-panel");
  await expect(pane).toHaveAttribute("data-panel", "computer");
  await expect(pane.getByRole("tab", { name: "Tasks" })).toBeVisible();
  await expect(pane.getByRole("tab", { name: "Screen" })).toHaveCount(0);
  await expect(pane).toContainText("Review the workspace");
  await captureScreenshot(page, testInfo, "workspace-tasks-running");
  await pane.getByRole("tab", { name: "Files" }).click();
  await pane.getByRole("button", { name: "notes.md", exact: true }).click();
  await expect(pane).toContainText("Workspace notes");
  await captureScreenshot(page, testInfo, "workspace-files-light");
  expect(unexpected).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(pane).toHaveAttribute("aria-hidden", "true");
});

test("workspace pane Terminal takes control explicitly and releases it when left", async ({
  page,
}, testInfo) => {
  const botId = bots[0]!.id;
  const computer = {
    botId,
    computerId: "fixture-computer",
    mode: "team",
    kind: "docker",
    state: "running",
    capabilities: { graphical: false, interactiveTerminal: true },
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: "saved",
    busyBotName: null,
    canUpdate: false,
  };
  const context = {
    botId,
    computerId: "fixture-computer",
    generation: 1,
    files: "unavailable",
    observedAt: "2026-09-28T00:00:00.000Z",
  };
  const calls: string[] = [];
  await installPerformanceFixture(page, false, false, {}, computer);
  await page.route("**/rpc/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(5);
    if (name === "terminal/available")
      return route.fulfill({ json: { json: { available: true } } });
    if (name === "computer/takeover") {
      calls.push(name);
      computer.controlHolder = "user";
      computer.controlBotId = botId;
      return route.fulfill({
        json: { json: { leaseId: "fixture-lease", expiresAt: "2099-01-01T00:00:00.000Z" } },
      });
    }
    if (name === "computer/release") {
      calls.push(name);
      computer.controlHolder = "none";
      computer.controlBotId = null;
      return route.fulfill({ json: { json: { ok: true } } });
    }
    if (name === "terminal/ticket") {
      calls.push(name);
      return route.fulfill({
        json: {
          json: {
            sessionId: "pane-terminal",
            ticket: "fixture-ticket",
            path: "/api/terminal/socket",
          },
        },
      });
    }
    if (name === "terminal/close") return route.fulfill({ json: { json: { ok: true } } });
    if (name === "workspace/describe") return route.fulfill({ json: { json: context } });
    await route.fallback();
  });
  await page.routeWebSocket("**/api/terminal/socket", (socket) => {
    socket.onMessage((message) => {
      if (typeof message === "string" && JSON.parse(message).type === "connect")
        socket.send(JSON.stringify({ type: "ready", inputSeq: 0 }));
    });
  });
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Agent computer" }).click();
  const pane = page.getByTestId("side-panel");
  await expect(pane).toHaveAttribute("data-panel", "computer");
  const tab = pane.getByRole("tab", { name: "Terminal" });
  await expect(tab).toBeVisible();
  await tab.click();
  // No ticket and no session before an explicit takeover.
  await expect(pane.getByText("Take control to open a terminal", { exact: true })).toBeVisible();
  expect(calls).not.toContain("terminal/ticket");
  await captureScreenshot(page, testInfo, "workspace-terminal-take-control");
  await pane.getByRole("button", { name: "Take control" }).click();
  await expect(pane.getByRole("region", { name: "Terminal", exact: true })).toBeVisible();
  expect(calls).toEqual(["computer/takeover", "terminal/ticket"]);
  await captureScreenshot(page, testInfo, "workspace-terminal-running");
  // Leaving the tab releases the control it acquired and closes the session.
  await pane.getByRole("tab", { name: "Tasks" }).click();
  await expect.poll(() => calls).toContain("computer/release");
});

test("workspace pane Terminal reports an ended session instead of a dead terminal", async ({
  page,
}, testInfo) => {
  const botId = bots[0]!.id;
  const computer = {
    botId,
    computerId: "fixture-computer",
    mode: "team",
    kind: "docker",
    state: "running",
    capabilities: { graphical: false, interactiveTerminal: true },
    controlHolder: "user",
    controlBotId: botId,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: "saved",
    busyBotName: null,
    canUpdate: false,
  };
  await installPerformanceFixture(page, false, false, {}, computer);
  await page.route("**/rpc/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(5);
    if (name === "terminal/available")
      return route.fulfill({ json: { json: { available: true } } });
    if (name === "terminal/ticket")
      return route.fulfill({
        status: 409,
        json: {
          json: {
            defined: false,
            code: "CONFLICT",
            status: 409,
            message: "A terminal is already open. Close it before opening another.",
          },
        },
      });
    if (name === "terminal/close") return route.fulfill({ json: { json: { ok: true } } });
    await route.fallback();
  });
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Agent computer" }).click();
  const pane = page.getByTestId("side-panel");
  await pane.getByRole("tab", { name: "Terminal" }).click();
  await expect(
    pane.getByText("A terminal is already open. Close it before opening another.", {
      exact: true,
    }),
  ).toBeVisible();
  await expect(pane.getByRole("button", { name: "Open a new terminal" })).toBeVisible();
  await captureScreenshot(page, testInfo, "workspace-terminal-ended");
});

test("workspace pane Terminal boots a stopped computer without taking control", async ({
  page,
}) => {
  const botId = bots[0]!.id;
  const computer = {
    botId,
    computerId: "fixture-computer",
    mode: "team",
    kind: "docker",
    state: "stopped",
    capabilities: { graphical: false, interactiveTerminal: true },
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: "saved",
    busyBotName: null,
    canUpdate: false,
  };
  const context = {
    botId,
    computerId: "fixture-computer",
    generation: 1,
    files: "unavailable",
    observedAt: "2026-09-28T00:00:00.000Z",
  };
  const calls: string[] = [];
  await installPerformanceFixture(page, false, false, {}, computer);
  await page.route("**/rpc/**", async (route) => {
    const url = new URL(route.request().url());
    const name = url.pathname.slice(5);
    if (name === "terminal/available")
      return route.fulfill({ json: { json: { available: true } } });
    if (name === "computer/boot") {
      calls.push(name);
      computer.state = "running";
      return route.fulfill({ json: { json: { ...computer, state: "running" } } });
    }
    if (name === "computer/takeover") {
      calls.push(name);
      return route.fulfill({
        json: { json: { leaseId: "fixture-lease", expiresAt: "2099-01-01T00:00:00.000Z" } },
      });
    }
    if (name === "workspace/describe") return route.fulfill({ json: { json: context } });
    await route.fallback();
  });
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Agent computer" }).click();
  const pane = page.getByTestId("side-panel");
  await expect(pane).toHaveAttribute("data-panel", "computer");
  const tab = pane.getByRole("tab", { name: "Terminal" });
  await expect(tab).toBeVisible();
  await tab.click();
  await expect(pane.getByText("Start computer to open a terminal", { exact: true })).toBeVisible();
  const startButton = pane.getByRole("button", { name: "Start computer" });
  await expect(startButton).toBeVisible();
  expect(calls).toEqual([]);
  await startButton.click();
  await expect.poll(() => calls).toEqual(["computer/boot"]);
  expect(calls).not.toContain("computer/takeover");
  await expect(pane.getByText("Take control to open a terminal", { exact: true })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Take control" })).toBeVisible();
});
