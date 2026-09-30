import { encodeTerminalFrame } from "@ardurbot/core";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { bots, installPerformanceFixture } from "./performance-fixture";
import { openWorkspaceView as openView } from "./workspace-view";

const version = "a".repeat(64);

function computerFor(botId: string) {
  return {
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
}

function fileBody(context: { files: string }, content: string) {
  return {
    context,
    path: "notes.md",
    content,
    size: content.length,
    binary: false,
    readOnly: false,
    version,
  };
}

async function installWorkspace(page: Page, files: "live" | "saved", saveReason?: string) {
  const botId = bots[0]!.id;
  const context = {
    botId,
    computerId: "fixture-computer",
    generation: 1,
    files,
    observedAt: "2026-09-28T00:00:00.000Z",
  };
  await installPerformanceFixture(page, false, false, {}, computerFor(botId));
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
  let reads = 0;
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
              ? fileBody(
                  context,
                  ++reads === 1 ? "Workspace notes\n" : "Workspace notes from disk\n",
                )
              : name === "workspace/save"
                ? {
                    saved: false,
                    approvalRequired: false,
                    reason: saveReason ?? "The file changed. Open it again before saving.",
                  }
                : undefined;
    if (result !== undefined) await route.fulfill({ json: { json: result } });
    else await route.fallback();
  });
  return { botId, unexpected };
}

async function openFiles(page: Page) {
  await page.getByRole("button", { name: "Agent computer" }).click();
  const pane = page.getByTestId("side-panel");
  await expect(pane).toHaveAttribute("data-panel", "computer");
  await openView(page, "Files");
  await pane.getByRole("button", { name: "notes.md", exact: true }).click();
  await expect(pane).toContainText("Workspace notes");
  return pane;
}

test("workspace pane opens Tasks and bot files without starting the computer", async ({
  page,
}, testInfo) => {
  const { botId, unexpected } = await installWorkspace(page, "live");
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  await page.getByRole("button", { name: "Agent computer" }).click();
  const pane = page.getByTestId("side-panel");
  await expect(pane).toHaveAttribute("data-panel", "computer");
  await expect(pane.getByRole("tab", { name: "Tasks" })).toBeVisible();
  await expect(pane.getByRole("tab", { name: "Routines", exact: true })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Show settings", exact: true })).toBeVisible();
  await expect(pane.getByRole("tab", { name: "Screen" })).toHaveCount(0);
  await expect(pane).toContainText("Review the workspace");
  await captureScreenshot(page, testInfo, "workspace-tasks-running");
  await openView(page, "Files");
  await pane.getByRole("button", { name: "notes.md", exact: true }).click();
  await expect(pane).toContainText("Workspace notes");
  await captureScreenshot(page, testInfo, "workspace-files-light");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await captureScreenshot(page, testInfo, "workspace-files-dark");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "light";
  });
  const editor = pane.locator("[data-ide-editor]");
  await editor.fill("Workspace notes changed");
  await pane.getByRole("button", { name: "Save", exact: true }).click();
  await expect(pane.getByRole("alert")).toHaveText(
    "The file changed. Open it again before saving.",
  );
  await expect(editor).toContainText("changed");
  await captureScreenshot(page, testInfo, "workspace-files-conflict");
  await pane.getByRole("treeitem", { name: "notes.md" }).getByRole("button").click();
  await expect(pane.getByRole("alert")).toHaveCount(0);
  await expect(editor).toContainText("Workspace notes from disk");
  await expect(editor).not.toContainText("changed");
  await captureScreenshot(page, testInfo, "workspace-files-reopened");
  expect(unexpected).toEqual([]);
  await page.keyboard.press("ControlOrMeta+Shift+E");
  await expect(pane).toHaveAttribute("aria-hidden", "true");
});

test("workspace views retain drafts across docking, expansion and return to chat", async ({
  page,
}, testInfo) => {
  const { botId, unexpected } = await installWorkspace(page, "live");
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const pane = await openFiles(page);
  const editor = pane.locator("[data-ide-editor]");
  await editor.fill("Unsaved workspace draft");
  await editor.evaluate((element) => element.setAttribute("data-draft-proof", "original"));
  await pane.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(pane.locator('[data-draft-proof="original"]')).toBeVisible();
  await captureScreenshot(page, testInfo, "workspace-views-expanded");
  await pane.getByRole("button", { name: "Back to chat", exact: true }).click();
  for (const [direction, position] of [
    ["left", "left"],
    ["down", "bottom"],
    ["right", "right"],
  ]) {
    await page.getByRole("button", { name: "Views", exact: true }).click();
    await page.getByRole("menuitem", { name: `Move split view ${direction}`, exact: true }).click();
    await expect(pane).toHaveAttribute("data-position", position!);
    await expect(pane.locator('[data-draft-proof="original"]')).toBeVisible();
    await captureScreenshot(page, testInfo, `workspace-views-${position}`);
  }
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(pane).toHaveAttribute("data-overlay", "true");
  await expect(pane.getByRole("tree", { name: "Files", exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "workspace-views-narrow");
  await pane.getByRole("button", { name: "Back to chat", exact: true }).click();
  await expect(pane).toHaveAttribute("aria-hidden", "true");
  await expect(page.getByRole("button", { name: "Agent computer", exact: true })).toBeFocused();
  await page.getByRole("button", { name: "Agent computer", exact: true }).click();
  await expect(pane.locator('[data-draft-proof="original"]')).toBeVisible();
  await expect(editor).toContainText("Unsaved workspace draft");
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(pane).toHaveAttribute("data-overlay", "false");
  await pane.getByRole("tab", { name: "Tasks", exact: true }).click();
  await pane.getByRole("button", { name: "Close Files", exact: true }).click();
  await expect(pane.getByRole("tab", { name: "Files", exact: true })).toHaveCount(0);
  await expect(pane.getByRole("tab", { name: "Tasks", exact: true })).toBeFocused();
  await captureScreenshot(page, testInfo, "workspace-views-closed");
  expect(unexpected).toEqual([]);
});

test("workspace pane shows saved files that can be edited", async ({ page }, testInfo) => {
  const { botId } = await installWorkspace(page, "saved");
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const pane = await openFiles(page);
  await expect(pane).toContainText("Saved files");
  await captureScreenshot(page, testInfo, "workspace-files-saved");
});

test("workspace pane Terminal keeps its shell across views and releases explicitly", async ({
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
    if (name === "terminal/close") {
      calls.push(name);
      return route.fulfill({ json: { json: { ok: true } } });
    }
    if (name === "workspace/describe") return route.fulfill({ json: { json: context } });
    await route.fallback();
  });
  let output = (_text: string) => {};
  await page.routeWebSocket("**/api/terminal/socket", (socket) => {
    output = (text) =>
      socket.send(Buffer.from(encodeTerminalFrame(1, new TextEncoder().encode(text))));
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
  const tab = await openView(page, "Terminal");
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
  await pane.locator("[data-terminal-root]").evaluate((element) => {
    element.setAttribute("data-session-proof", "original");
  });
  // Hidden output still reaches the same xterm, while authority stays beside chat.
  await pane.getByRole("tab", { name: "Tasks" }).click();
  await expect(pane.getByText("You control the computer", { exact: true })).toBeVisible();
  await expect(pane.getByRole("button", { name: "Release", exact: true })).toBeVisible();
  output("Background job still running\r\n");
  await captureScreenshot(page, testInfo, "workspace-terminal-hidden");
  await tab.click();
  await expect(pane.locator('[data-terminal-root][data-session-proof="original"]')).toBeVisible();
  await expect(pane.locator(".xterm-accessibility-tree")).toContainText(
    "Background job still running",
  );
  expect(calls).toEqual(["computer/takeover", "terminal/ticket"]);
  await pane.getByRole("button", { name: "Expand", exact: true }).click();
  await expect(pane.locator('[data-terminal-root][data-session-proof="original"]')).toBeVisible();
  await pane.getByRole("button", { name: "Back to chat", exact: true }).click();
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("End this terminal?");
    await dialog.dismiss();
  });
  await pane
    .getByRole("tablist", { name: "Views", exact: true })
    .getByRole("button", { name: "Close Terminal", exact: true })
    .click();
  await expect(pane).toHaveAttribute("aria-hidden", "false");
  expect(calls).toEqual(["computer/takeover", "terminal/ticket"]);
  page.once("dialog", async (dialog) => {
    expect(dialog.message()).toBe("End this terminal?");
    await dialog.accept();
  });
  await pane.getByRole("button", { name: "Release", exact: true }).click();
  await expect.poll(() => calls.filter((name) => name === "computer/release").length).toBe(1);
  await expect.poll(() => calls.filter((name) => name === "terminal/close").length).toBe(1);
  await expect(pane.getByText("You control the computer", { exact: true })).toHaveCount(0);
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
  await openView(page, "Terminal");
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
  const tab = await openView(page, "Terminal");
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
