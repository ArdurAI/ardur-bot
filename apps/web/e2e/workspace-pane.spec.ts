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
