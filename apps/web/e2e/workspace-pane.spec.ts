import { expect, type Page, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { bots, installPerformanceFixture } from "./performance-fixture";

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
  await pane.getByRole("tab", { name: "Files" }).click();
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
  await expect(pane.getByRole("tab", { name: "Screen" })).toHaveCount(0);
  await expect(pane).toContainText("Review the workspace");
  await captureScreenshot(page, testInfo, "workspace-tasks-running");
  await pane.getByRole("tab", { name: "Files" }).click();
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

test("workspace pane shows saved files that can be edited", async ({ page }, testInfo) => {
  const { botId } = await installWorkspace(page, "saved");
  await page.goto(`/app/${botId}`);
  await expect(page.getByTestId("shell-root")).toHaveAttribute("data-ready", "true");
  const pane = await openFiles(page);
  await expect(pane).toContainText("Saved files");
  await captureScreenshot(page, testInfo, "workspace-files-saved");
});
