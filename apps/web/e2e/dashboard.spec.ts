import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test.use({ viewport: { width: 1280, height: 900 } });

test("Dashboard opens first, preserves Bots navigation and approves through the existing thread action", async ({
  page,
}, testInfo) => {
  const now = "2026-09-24T12:00:00.000Z";
  await page.clock.setFixedTime(new Date("2026-09-24T12:00:30.000Z"));
  const user = {
    id: "fixture-user",
    name: "Owner",
    email: "owner@example.test",
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  };
  const me = {
    userId: user.id,
    email: user.email,
    name: user.name,
    spaceId: "space",
    isDeploymentOwner: true,
    needsModel: false,
    defaultProvider: "fake",
    defaultModel: "fake",
    computerHost: "docker",
    canChooseHostComputer: false,
    sandboxProvider: "fake",
    avatarStyle: "robot",
  };
  const bot = {
    id: "bot",
    spaceId: "space",
    name: "Reviewer",
    title: "",
    description: "",
    instructions: "",
    color: "slate",
    notifyOnFinish: false,
    pinned: false,
    sectionId: null,
    archivedAt: null,
    unread: false,
    parentBotId: null,
    memoryScope: null,
    threadId: "thread",
    preview: "",
    status: "idle",
    computerMode: "team",
    createdAt: now,
    updatedAt: now,
    voiceId: null,
    autoSpeak: false,
    modelProvider: null,
    modelId: null,
    thinkingLevel: null,
    teamChatAmbientEnabled: false,
    teamChatRules: "",
    webhookConfigured: false,
    spawnKey: null,
    runtimeKind: "pi",
    modelCredentialId: null,
    pinRevision: 0,
  };
  const space = {
    id: "space",
    name: "Workspace",
    isDefault: true,
    hasContent: true,
    bots: [bot],
    groups: [],
    externalConversations: [],
    botSections: [],
  };
  let answered = false;
  let approvedInput: unknown;
  const snapshot = () => ({
    botId: "bot",
    threadId: "thread",
    cursor: 0,
    olderCursor: null,
    run: answered
      ? null
      : {
          id: "run",
          botId: "bot",
          taskId: "task",
          status: "waiting_input",
          trigger: "user",
          createdAt: now,
          updatedAt: now,
        },
    messages: answered
      ? []
      : [
          {
            id: "message",
            threadId: "thread",
            runId: "run",
            seq: 1,
            role: "bot",
            createdAt: now,
            blocks: [
              {
                kind: "ask",
                text: "Send the draft?",
                status: "pending",
                approvalEffectId: "effect",
                actions: [
                  { id: "allow", label: "Allow once" },
                  { id: "deny", label: "Deny" },
                ],
              },
            ],
          },
        ],
  });
  await page.route("**/api/auth/get-session*", (route) =>
    route.fulfill({
      json: {
        user,
        session: {
          id: "session",
          userId: user.id,
          token: "fixture-session",
          expiresAt: "2099-01-01T00:00:00Z",
          createdAt: now,
          updatedAt: now,
        },
      },
    }),
  );
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    const values: Record<string, unknown> = {
      me,
      bootstrap: {
        me,
        bots: [bot],
        groups: [],
        archivedBots: [],
        archivedGroups: [],
        botSections: [],
        thread: snapshot(),
        routines: [],
        spaces: [space],
      },
      "spaces/list": { current: { ...space, bots: [bot] }, spaces: [space] },
      "bots/list": [bot],
      "bots/get": bot,
      "team/board": { rows: [] },
      "host/status": { configured: false, connected: false, roots: [], health: null },
      "routines/overview": { next: [], recent: [] },
      "usage/summary": {
        inputTokens: 0,
        outputTokens: 0,
        runs: 0,
        dayStart: now,
        weekStart: "2026-09-21T00:00:00Z",
        asOf: now,
        providers: [],
      },
      "learning/list": {
        pendingCount: 0,
        appliedThisWeek: 0,
        proposals: [],
        reviews: [],
        botNames: {},
      },
      "learning/summary": { pendingCount: 0, appliedThisWeek: 0 },
      "features/list": [{ feature: "governance", state: "unavailable" }],
      "threads/get": snapshot(),
      "threads/head": snapshot(),
      "runs/list": {
        runs: answered
          ? []
          : [
              {
                runId: "run",
                botId: "bot",
                botName: "Reviewer",
                threadId: "thread",
                groupId: null,
                groupName: null,
                status: "waiting_input",
                trigger: "user",
                promptSnippet: "Review the draft",
                updatedAt: now,
                startedAt: now,
                notificationsEnabled: false,
              },
            ],
      },
      "messaging/status": { enabled: false, providers: [], identities: [], openSignup: false },
      "voice/status": { transcribe: false, synthesize: false },
      "memory/config": null,
    };
    if (procedure === "threads/answer") {
      approvedInput = route.request().postDataJSON().json;
      answered = true;
      await route.fulfill({ json: { json: { ok: true } } });
    } else if (procedure === "threads/subscribe") {
      await route.fulfill({ contentType: "text/event-stream", body: "" });
    } else {
      await route.fulfill({
        json: { json: Object.hasOwn(values, procedure) ? values[procedure] : [] },
      });
    }
  });
  await page.goto("/app");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await expect(page).toHaveTitle("Dashboard — Ardur Bot");
  await expect(page.getByText("Waiting for your approval", { exact: true })).toBeVisible();
  const governance = page.locator('[data-panel="governance"]');
  await expect(governance.getByRole("link")).toHaveText(
    "Governance and encryption are not part of this build yet.",
  );
  await expect(governance.getByRole("button")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "dashboard-overview");
  await page.getByRole("button", { name: "Allow once", exact: true }).click();
  await expect
    .poll(() => approvedInput)
    .toEqual({
      botId: "bot",
      threadId: "thread",
      runId: "run",
      messageId: "message",
      answer: "allow",
    });
  await expect(page.getByText("Nothing running", { exact: true })).toBeVisible();
  await page.keyboard.press("Control+2");
  await expect(page).toHaveURL(/\/app\/(?:bots|bot)$/);
  await expect(page.getByTestId("bot-settings-trigger")).toBeVisible();
  await expect(page).toHaveTitle("Bots — Ardur Bot");
  const cachedRenderMs = await page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const start = performance.now();
        const observer = new MutationObserver(() => {
          if (document.querySelectorAll('[data-testid="dashboard"] [data-panel]').length !== 7)
            return;
          if (document.querySelector('[data-testid="dashboard"] [aria-busy="true"]')) return;
          observer.disconnect();
          requestAnimationFrame(() =>
            requestAnimationFrame(() => resolve(performance.now() - start)),
          );
        });
        observer.observe(document.body, { childList: true, subtree: true });
        window.dispatchEvent(
          new KeyboardEvent("keydown", { key: "1", ctrlKey: true, cancelable: true }),
        );
      }),
  );
  await testInfo.attach("dashboard-cached-render", {
    body: JSON.stringify({ milliseconds: cachedRenderMs }),
    contentType: "application/json",
  });
  expect(cachedRenderMs).toBeLessThan(200);
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("combobox", { name: "Open to", exact: true }).selectOption("bots");
  await page.keyboard.press("Escape");
  await page.goto("/app");
  await expect(page).toHaveTitle("Bots — Ardur Bot");
  await expect(page.getByTestId("dashboard")).toHaveCount(0);
  await page.keyboard.press("Control+1");
  await expect(page.getByTestId("dashboard")).toBeVisible();
  await page.keyboard.press("Control+3");
  await expect(page).toHaveURL(/\/app\/team$/);
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
  await expect(page).toHaveTitle("Board — Ardur Bot");
});
