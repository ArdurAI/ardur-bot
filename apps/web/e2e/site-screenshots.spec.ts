import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { BOT_COLORS } from "@ardurbot/contracts";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { listPiCatalog } from "../../../packages/adapters/src/pi-models";
import { dashboardFixture } from "./dashboard-fixture";
import { openWorkspaceView } from "./workspace-view";

const outputDir = process.env.SITE_SCREENSHOTS_DIR;
test.skip(!outputDir, "Website screenshots run in the site assets publish job.");
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2, colorScheme: "light" });

async function captureSiteScreenshot(page: Page, id: string) {
  if (!outputDir) throw new Error("SITE_SCREENSHOTS_DIR is required.");
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `${id}.png`);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage: false });
  if ((await stat(file)).size > 1_500_000) {
    throw new Error(`${id}.png exceeds the 1.5 MB site assets limit.`);
  }
}

function showcaseData() {
  const fixture = dashboardFixture(6);
  const base = fixture.rpc("bootstrap") as {
    me: Record<string, unknown>;
    bots: (Record<string, unknown> & { id: string; threadId: string })[];
    spaces: Record<string, unknown>[];
    thread: Record<string, unknown>;
  };
  const names = [
    "Chief of Staff",
    "Inbox Manager",
    "Research Scout",
    "Release Captain",
    "Expense Manager",
    "Calendar Keeper",
  ];
  const catalog = listPiCatalog();
  const model = (provider: string, id: string) => {
    if (!catalog.some((entry) => entry.provider === provider && entry.id === id))
      throw new Error(`Missing bundled model ${provider}/${id}`);
    return { modelProvider: provider, modelId: id, thinkingLevel: "medium" };
  };
  const choices = [
    model("openai-codex", "gpt-6-sol"),
    model("anthropic", "claude-sonnet-4-6"),
    model("google", "gemini-2.5-pro"),
    model("openai", "gpt-4.1"),
    model("xai", "grok-4.3"),
    model("openai-codex", "gpt-6-sol"),
  ];
  const credentialId = (index: number) => `showcase-model-${index}`;
  const credentials = choices.map((choice, index) => ({
    id: credentialId(index),
    provider: choice.modelProvider,
    label: `${names[index]} connection`,
    hasKey: true,
    isDefault: index === 0,
    modelId: choice.modelId,
  }));
  const bots = base.bots.map((bot, index) => ({
    ...bot,
    name: names[index],
    color: BOT_COLORS[index],
    ...choices[index],
    modelCredentialId: credentialId(index),
    preview: index === 0 ? "Ready to send the weekly plan" : "",
    unread: false,
  }));
  const group = {
    id: "operations-group",
    spaceId: "space",
    name: "Operations huddle",
    pinned: false,
    sectionId: null,
    archivedAt: null,
    members: [0, 1, 3].map((index) => ({
      botId: bots[index]!.id,
      name: bots[index]!.name,
      color: bots[index]!.color,
      status: "idle",
    })),
    threadId: "operations-thread",
    preview: "Release checklist is ready for review.",
    unread: false,
    updatedAt: "2026-09-24T12:00:00.000Z",
    createdAt: "2026-09-24T12:00:00.000Z",
  };
  const message = (
    id: string,
    threadId: string,
    seq: number,
    role: "user" | "bot",
    text: string,
    botId?: string,
  ) => ({
    id,
    threadId,
    seq,
    role,
    ...(botId ? { botId } : {}),
    blocks: [{ kind: "text", text }],
    createdAt: "2026-09-24T12:00:00.000Z",
  });
  const appMessages = [
    message(
      "app-1",
      "thread",
      1,
      "user",
      "Check this week's release checklist and draft a team update.",
    ),
    message(
      "app-2",
      "thread",
      2,
      "bot",
      "I'll inspect the checklist, then summarize anything that still needs attention.",
      "bot",
    ),
    {
      id: "app-3",
      threadId: "thread",
      seq: 3,
      role: "bot",
      botId: "bot",
      runId: "run",
      createdAt: "2026-09-24T12:00:00.000Z",
      blocks: [
        {
          kind: "command",
          command: {
            commandId: "checklist-command",
            runId: "run",
            attemptId: "attempt",
            executionId: "execution",
            command: "cat planning/release-checklist.md",
            cwd: "/home/ardurbot/workspace",
            computerId: null,
            computer: "Team computer",
            startedAt: "2026-09-24T12:00:00.000Z",
            durationMs: 2_400,
            exitCode: 0,
            outcome: "completed",
            stdout: "Build verified\nChecks passed\nRelease note drafted\n",
            stderr: null,
            error: null,
            redacted: false,
            truncated: false,
            replayOf: null,
            rerunDisabledReason: "Demo fixture",
          },
        },
      ],
    },
    message(
      "app-4",
      "thread",
      4,
      "bot",
      "The build and checks are complete. The release note is drafted; I can send the team a short update.",
      "bot",
    ),
    {
      id: "app-5",
      threadId: "thread",
      seq: 5,
      role: "bot",
      botId: "bot",
      runId: "run",
      createdAt: "2026-09-24T12:00:00.000Z",
      blocks: [
        {
          kind: "ask",
          text: "Send the team update?",
          detail: "The release checklist is complete, and the weekly update is ready for review.",
          status: "pending",
          approvalEffectId: "effect",
          actions: [
            { id: "allow", label: "Allow once" },
            { id: "deny", label: "Deny" },
          ],
        },
      ],
    },
  ];
  const groupMessages = [
    message(
      "group-1",
      group.threadId,
      1,
      "user",
      "Can we ship the weekly update after today's checks?",
    ),
    message(
      "group-2",
      group.threadId,
      2,
      "bot",
      "I have the draft. Inbox Manager, please check whether any customer reply changes the summary.",
      "bot",
    ),
    message(
      "group-3",
      group.threadId,
      3,
      "bot",
      "Two replies arrived this morning. I added their follow-ups to the draft.",
      "bot-1",
    ),
    {
      id: "group-4",
      threadId: group.threadId,
      seq: 4,
      role: "bot",
      botId: "bot-1",
      createdAt: group.createdAt,
      blocks: [
        {
          kind: "handoff",
          fromBotId: "bot-1",
          toBotId: "bot-3",
          text: "Release Captain, verify the deployment status before we send this.",
        },
      ],
    },
    message(
      "group-5",
      group.threadId,
      5,
      "bot",
      "Checks are green and the release note matches the deployed version. Ready for approval.",
      "bot-3",
    ),
  ];
  const routines = [
    {
      id: "morning-brief",
      name: "Morning brief",
      crons: ["0 8 * * 1-5"],
      prompt: "Prepare today's priorities",
      nextRunAt: "2026-09-25T08:00:00.000Z",
    },
    {
      id: "inbox-triage",
      name: "Inbox triage",
      crons: ["0 11 * * 1-5"],
      prompt: "Review urgent mail",
      nextRunAt: "2026-09-25T11:00:00.000Z",
    },
    {
      id: "evening-wrap",
      name: "Evening wrap-up",
      crons: ["0 16 * * *"],
      prompt: "Summarize today's work",
      nextRunAt: "2026-09-24T16:00:00.000Z",
    },
  ].map((routine) => ({
    ...routine,
    botId: "bot",
    timezone: "UTC",
    active: true,
    notify: true,
    webhookEnabled: false,
    githubEnabled: false,
    messageProvider: null,
    lastRunAt: null,
    createdAt: group.createdAt,
  }));
  const appSnapshot = { ...base.thread, cursor: 5, messages: appMessages };
  const groupSnapshot = {
    threadId: group.threadId,
    groupId: group.id,
    groupName: group.name,
    members: group.members,
    cursor: 5,
    olderCursor: null,
    run: null,
    messages: groupMessages,
  };
  return { fixture, base, bots, catalog, credentials, group, routines, appSnapshot, groupSnapshot };
}

test("captures bot chat, group collaboration, and routines from seeded demo data", async ({
  page,
}) => {
  const data = showcaseData();
  await page.clock.setFixedTime(new Date("2026-09-24T12:00:30.000Z"));
  await page.route("**/api/auth/get-session*", (route) =>
    route.fulfill({ json: data.fixture.session }),
  );
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    const input = route.request().postDataJSON()?.json as
      | { groupId?: string; botId?: string }
      | undefined;
    if (procedure === "models/list") {
      const configured = data.catalog.filter((entry) =>
        data.credentials.some(
          (credential) => credential.provider === entry.provider && credential.modelId === entry.id,
        ),
      );
      return route.fulfill({ json: { json: configured } });
    }
    if (procedure === "models/credentials")
      return route.fulfill({ json: { json: data.credentials } });
    if (procedure === "host/status")
      return route.fulfill({
        json: { json: { configured: true, connected: true, roots: [], health: null } },
      });
    if (procedure === "computer/status")
      return route.fulfill({
        json: {
          json: {
            botId: "bot",
            computerId: "demo-computer",
            kind: "desktop",
            mode: "team",
            state: "stopped",
            connectionId: "demo-engine",
            imageProfile: "base",
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
      });
    if (procedure === "computer/connections")
      return route.fulfill({
        json: {
          json: [{ id: "demo-engine", name: "Docker Desktop", settings: { engine: "docker" } }],
        },
      });
    if (procedure === "computer/list") return route.fulfill({ json: { json: [] } });
    const original = data.fixture.rpc(procedure, input);
    const space = { ...data.base.spaces[0], bots: data.bots, groups: [data.group] };
    const result =
      procedure === "bootstrap"
        ? {
            ...(original as object),
            me: {
              ...data.base.me,
              defaultProvider: "openai-codex",
              defaultModel: "gpt-6-sol",
              sandboxProvider: "docker",
            },
            bots: data.bots,
            groups: [data.group],
            spaces: [space],
            routines: data.routines,
            thread: data.appSnapshot,
          }
        : procedure === "me"
          ? {
              ...(original as object),
              defaultProvider: "openai-codex",
              defaultModel: "gpt-6-sol",
              sandboxProvider: "docker",
            }
          : procedure === "spaces/list"
            ? { current: space, spaces: [space] }
            : procedure === "bots/list"
              ? data.bots
              : procedure === "bots/get"
                ? (data.bots.find((bot) => bot.id === input?.botId) ?? data.bots[0])
                : procedure === "groups/list"
                  ? [data.group]
                  : procedure === "workspace/tasks"
                    ? {
                        runs: [],
                        delegations: [],
                        routines: [],
                        observedAt: "2026-09-24T12:00:30.000Z",
                      }
                    : procedure === "workspace/describe"
                      ? {
                          botId: input?.botId ?? "bot",
                          computerId: null,
                          generation: null,
                          files: "unavailable",
                          observedAt: "2026-09-24T12:00:30.000Z",
                        }
                      : procedure === "routines/list"
                        ? input?.botId === "bot"
                          ? data.routines
                          : []
                        : procedure === "runs/list" || procedure === "dashboard/now"
                          ? {
                              ...(original as object),
                              runs: (original as { runs: Record<string, unknown>[] }).runs.map(
                                (run) => ({
                                  ...run,
                                  botName: "Chief of Staff",
                                  promptSnippet: "Review release checklist",
                                }),
                              ),
                            }
                          : procedure === "threads/get" || procedure === "threads/head"
                            ? input?.groupId === data.group.id
                              ? data.groupSnapshot
                              : data.appSnapshot
                            : original;
    await route.fulfill({ json: { json: result } });
  });

  await page.goto("/app/bot");
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(page.getByText("cat planning/release-checklist.md")).toBeVisible();
  await expect(page.getByRole("button", { name: /Change model: Ardur · Codex/ })).toContainText(
    "medium",
  );
  await expect(page.getByRole("button", { name: /Change model: Ardur · Codex/ })).not.toContainText(
    "not available",
  );
  // Commands live in the compact work record; expand it before the capture.
  await page.getByText("cat planning/release-checklist.md").click();
  await expect(page.getByTestId("command-block")).toContainText(
    "in /home/ardurbot/workspace · 2 s · exit 0",
  );
  await expect(
    page.locator("main").getByRole("button", { name: "Bot settings", exact: true }),
  ).toBeVisible();
  await captureSiteScreenshot(page, "app-chat");

  await page.getByTestId("bot-settings-trigger").click();
  const botSettings = page.getByTestId("bot-settings");
  const runtimeSummary = botSettings.getByTestId("runtime-summary");
  await expect(runtimeSummary).toContainText("Container");
  await expect(runtimeSummary).toContainText("Docker Desktop");
  await expect(runtimeSummary).not.toContainText("Runs as you");
  await expect(runtimeSummary).toContainText("Bots share files and installed tools");
  await runtimeSummary.scrollIntoViewIfNeeded();
  await botSettings.getByText("Change location", { exact: true }).click();
  const locations = botSettings.getByTestId("computer-location-picker");
  await expect(locations.getByRole("button", { name: "This computer", exact: true })).toBeEnabled();
  await expect(locations.getByRole("button", { name: "Sandbox", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await locations.scrollIntoViewIfNeeded();
  await captureSiteScreenshot(page, "bot-runtime-settings");

  await page.goto("/app/g/operations-group");
  await expect(page.getByTestId("group-participant-models")).toBeVisible();
  // Three members: the capture must show the separator between each pair.
  await expect(page.getByTestId("group-participant-separator")).toHaveCount(2);
  await expect(
    page.locator("main").getByRole("button", { name: "Group settings", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText("Checks are green and the release note matches the deployed version.", {
      exact: false,
    }),
  ).toBeVisible();
  await captureSiteScreenshot(page, "group-chat");

  await page.goto("/app/bot");
  await page.getByTitle("Agent computer").click();
  await openWorkspaceView(page, "Routines");
  await expect(page.getByText("Morning brief")).toBeVisible();
  await expect(page.getByText("Every day at 4:00 PM")).toBeVisible();
  await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "computer");
  await captureSiteScreenshot(page, "routines");

  await page
    .locator("header.app-drag")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-nav-memory").click();
  await expect(settings.getByTestId("memory-settings-page")).toBeVisible();
  await expect(settings.getByRole("link", { name: "Learn more about Memory" })).toHaveAttribute(
    "href",
    "https://ardur.ai/docs/features/memory-documents/",
  );
  await settings
    .getByRole("group", { name: "Memory storage", exact: true })
    .getByRole("button", { name: "Manage", exact: true })
    .click();
  const memory = settings.getByTestId("memory-settings");
  await expect(memory.getByLabel("Memory location")).toHaveValue("postgres");
  await memory.getByLabel("Memory location").selectOption("git");
  await expect(memory.getByLabel("Repository URL")).toBeVisible();
  await expect(memory.getByLabel("Publication mode")).toHaveValue("publish");
  await captureSiteScreenshot(page, "memory-git");
});
