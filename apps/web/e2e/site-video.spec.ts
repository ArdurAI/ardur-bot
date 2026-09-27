import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { listPiCatalog } from "../../../packages/adapters/src/pi-models";
import { dashboardFixture } from "./dashboard-fixture";

const outputDir = process.env.SITE_VIDEO_DIR;
test.skip(!outputDir, "Website video recording requires SITE_VIDEO_DIR.");

const instruction =
  "Make a short morning checklist from these sample notes: review the project plan; prepare questions for the afternoon meeting; check the weekly draft. Return three concise bullets here. Use only these notes. Do not use tools or change anything.";
const sampleNotes = instruction.match(
  /sample notes: (.+?)\. Return three concise bullets here\./,
)?.[1];
if (!sampleNotes) throw new Error("The sample instruction has no notes to summarize.");
const reply = sampleNotes
  .split("; ")
  .map((note) => `- ${note[0]!.toUpperCase()}${note.slice(1)}.`)
  .join("\n");
const shotDurations = [5, 6, 9, 9, 5, 6, 9, 7] as const;

test("records the Routines walkthrough", async ({ browser }) => {
  if (!outputDir) throw new Error("SITE_VIDEO_DIR is required.");
  await mkdir(outputDir, { recursive: true });

  const fixture = dashboardFixture();
  const warmupContext = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "en-US",
    timezoneId: "UTC",
  });
  const warmupPage = await warmupContext.newPage();
  await warmupPage.route("**/api/auth/get-session*", (route) =>
    route.fulfill({ json: fixture.session }),
  );
  await warmupPage.route("**/rpc/**", (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    const input = route.request().postDataJSON()?.json as Record<string, unknown> | undefined;
    return route.fulfill({ json: { json: fixture.rpc(procedure, input) } });
  });
  // The warm-up serves the plain fixture, whose bot keeps its own name; only the recording renames it.
  const warmupBot = (fixture.rpc("bootstrap") as { bots: { name: string }[] }).bots[0]!;
  try {
    await warmupPage.goto("/app/bot");
    await expect(warmupPage.getByText(warmupBot.name).first()).toBeVisible();
  } finally {
    await warmupContext.close();
  }

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    screen: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
    colorScheme: "light",
    locale: "en-US",
    timezoneId: "UTC",
    reducedMotion: "no-preference",
    recordVideo: { dir: outputDir, size: { width: 1920, height: 1080 } },
  });
  const page = await context.newPage();
  const video = page.video();
  const base = fixture.rpc("bootstrap") as {
    me: Record<string, unknown>;
    bots: (Record<string, unknown> & { id: string; threadId: string })[];
    spaces: Record<string, unknown>[];
    thread: Record<string, unknown>;
  };
  const catalog = listPiCatalog();
  const choice = {
    modelProvider: "openai-codex",
    modelId: "gpt-6-sol",
    thinkingLevel: "medium" as const,
  };
  if (
    !catalog.some((entry) => entry.provider === choice.modelProvider && entry.id === choice.modelId)
  ) {
    throw new Error(`Missing bundled model ${choice.modelProvider}/${choice.modelId}`);
  }
  const credential = {
    id: "showcase-model-0",
    provider: choice.modelProvider,
    label: "Briefing connection",
    hasKey: true,
    isDefault: true,
    modelId: choice.modelId,
  };
  const credentials = [credential];
  const configuredModels = catalog.filter((entry) =>
    credentials.some((item) => item.provider === entry.provider && item.modelId === entry.id),
  );
  const me = {
    ...base.me,
    defaultProvider: choice.modelProvider,
    defaultModel: choice.modelId,
  };
  const bot = {
    ...base.bots[0],
    name: "Briefing",
    status: "idle",
    preview: "",
    unread: false,
    ...choice,
    modelCredentialId: credential.id,
  };
  const space = { ...base.spaces[0], bots: [bot], groups: [] };
  const startedAt = Date.now();
  let routine: Record<string, unknown> | null = null;
  let runStartedAt: number | null = null;
  const shots: { id: number; startMs: number; endMs: number; actionEndMs: number }[] = [];
  const offset = () => Date.now() - startedAt;
  const completed = () => runStartedAt !== null && Date.now() - runStartedAt >= 10_000;
  const snapshot = () => ({
    ...base.thread,
    botId: bot.id,
    threadId: bot.threadId,
    cursor: completed() ? 1 : 0,
    olderCursor: null,
    run: null,
    messages: completed()
      ? [
          {
            id: "briefing-reply",
            threadId: bot.threadId,
            runId: "briefing-run",
            seq: 1,
            role: "bot",
            botId: bot.id,
            createdAt: new Date(runStartedAt!).toISOString(),
            blocks: [{ kind: "text", text: reply }],
          },
        ]
      : [],
  });
  const history = () =>
    runStartedAt === null
      ? []
      : [
          {
            id: "briefing-run",
            status: completed() ? "completed" : "queued",
            createdAt: new Date(runStartedAt).toISOString(),
            completedAt: completed() ? new Date(runStartedAt + 10_000).toISOString() : null,
          },
        ];

  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    const input = route.request().postDataJSON()?.json as Record<string, unknown> | undefined;
    let result: unknown;
    switch (procedure) {
      case "bootstrap":
        result = {
          ...base,
          me,
          bots: [bot],
          groups: [],
          spaces: [space],
          routines: routine ? [routine] : [],
          thread: snapshot(),
        };
        break;
      case "me":
        result = me;
        break;
      case "models/list":
        result = configuredModels;
        break;
      case "models/credentials":
        result = credentials;
        break;
      case "spaces/list":
        result = { current: space, spaces: [space] };
        break;
      case "bots/list":
        result = [bot];
        break;
      case "bots/get":
        result = bot;
        break;
      case "routines/list":
        result = routine ? [routine] : [];
        break;
      case "routines/create": {
        if (
          routine ||
          input?.botId !== bot.id ||
          input.name !== "Morning checklist" ||
          input.prompt !== instruction ||
          input.timezone !== "UTC" ||
          input.active !== true ||
          JSON.stringify(input.crons) !== JSON.stringify(["0 8 * * 1-5"])
        ) {
          return route.fulfill({ status: 400, body: "Unexpected routine input" });
        }
        routine = {
          ...input,
          id: "morning-checklist",
          lastRunAt: null,
          nextRunAt: "2026-09-28T08:00:00.000Z",
          createdAt: new Date().toISOString(),
        };
        result = routine;
        break;
      }
      case "routines/testRun":
        if (!routine || input?.routineId !== routine.id || runStartedAt !== null)
          return route.fulfill({ status: 400, body: "Unexpected test run" });
        runStartedAt = Date.now();
        await new Promise((resolve) => setTimeout(resolve, 750));
        result = { runId: "briefing-run" };
        break;
      case "routines/history":
        result = input?.routineId === routine?.id ? history() : [];
        break;
      case "threads/get":
      case "threads/head":
        result = snapshot();
        break;
      case "runs/list":
        result = { runs: [] };
        break;
      case "dashboard/now":
        result = { ...(fixture.rpc(procedure, input) as object), runs: [] };
        break;
      default:
        result = fixture.rpc(procedure, input);
    }
    await route.fulfill({ json: { json: result } });
  });

  async function shot(id: number, action: () => Promise<void>) {
    const startMs = offset();
    await action();
    const actionEndMs = offset();
    const elapsed = actionEndMs - startMs;
    const budgetMs = shotDurations[id - 1]! * 1_000;
    if (elapsed > budgetMs * 2) {
      throw new Error(
        `Action for shot ${id} took ${elapsed}ms, exceeding 2x budget of ${budgetMs}ms.`,
      );
    }
    await page.waitForTimeout(Math.max(0, budgetMs + 300 - elapsed));
    shots.push({ id, startMs, endMs: offset(), actionEndMs });
  }

  let processingCut: { startMs: number; endMs: number } | null = null;
  try {
    await shot(1, async () => {
      await page.goto("/app/bot");
      await expect(page.getByText("Briefing").first()).toBeVisible();
      await expect(page.getByText(reply)).toHaveCount(0);
      await page.getByTitle("Agent computer").click();
      await expect(page.getByRole("button", { name: "Create Routine" })).toBeVisible();
    });
    await shot(2, async () => {
      await page.getByRole("button", { name: "Create Routine" }).click();
      await expect(page.getByTestId("side-panel")).toHaveAttribute("data-panel", "routine");
      await page.getByPlaceholder("Name this routine").fill("Morning checklist");
      await expect(page.getByRole("switch", { name: "Active" })).toHaveAttribute(
        "aria-checked",
        "true",
      );
    });
    await shot(3, async () => {
      await page
        .getByPlaceholder("What should this routine do each time it runs?")
        .fill(instruction);
      await expect(
        page.getByPlaceholder("What should this routine do each time it runs?"),
      ).toHaveValue(instruction);
    });
    await shot(4, async () => {
      await page.getByRole("button", { name: "Add trigger" }).click();
      await page.getByRole("menuitem", { name: "On a schedule" }).hover();
      await page.getByRole("menuitem", { name: "Weekdays", exact: true }).click();
      await page.getByLabel("Time of day").selectOption("8:00 AM");
      await expect(page.getByLabel("How often")).toHaveValue("Weekdays");
      await expect(page.getByTestId("side-panel")).toContainText("UTC");
    });
    await shot(5, async () => {
      const saved = page.waitForResponse(
        (response) => response.url().includes("/rpc/routines/create") && response.ok(),
      );
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await saved;
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
      await expect(page.getByRole("button", { name: "Test run" })).toBeEnabled();
      expect(routine).toMatchObject({
        name: "Morning checklist",
        prompt: instruction,
        crons: ["0 8 * * 1-5"],
        timezone: "UTC",
        active: true,
      });
    });
    await shot(6, async () => {
      await page.getByRole("button", { name: "Test run" }).click();
      const panel = page.getByTestId("side-panel");
      await expect(panel).toContainText("Run history");
      await panel.getByText("Run history").scrollIntoViewIfNeeded();
      await expect(panel.getByText("Queued", { exact: true })).toBeVisible();
    });
    const seventhStartMs = offset();
    const processingStartMs = offset();
    await expect.poll(() => history()[0]?.status, { timeout: 20_000 }).toBe("completed");
    await page.reload();
    await expect(page.getByText("Review the project plan.")).toBeVisible();
    await expect(page.getByText("Prepare questions for the afternoon meeting.")).toBeVisible();
    await expect(page.getByText("Check the weekly draft.")).toBeVisible();
    processingCut = { startMs: processingStartMs, endMs: offset() };
    await page.waitForTimeout(2_500);
    await page.getByTitle("Agent computer").click();
    await page.getByRole("button", { name: /Morning checklist/ }).click();
    const panel = page.getByTestId("side-panel");
    await panel.getByText("Run history").scrollIntoViewIfNeeded();
    await expect(panel.getByText("Done", { exact: true })).toBeVisible();
    await expect(panel.locator("time")).toHaveCount(1);
    const seventhActionEndMs = offset();
    const seventhElapsed = seventhActionEndMs - processingCut.endMs;
    const seventhBudgetMs = shotDurations[6]! * 1_000;
    if (seventhElapsed > seventhBudgetMs * 2) {
      throw new Error(
        `Action for shot 7 took ${seventhElapsed}ms, exceeding 2x budget of ${seventhBudgetMs}ms.`,
      );
    }
    await page.waitForTimeout(Math.max(0, 9_300 - (offset() - processingCut.endMs)));
    shots.push({
      id: 7,
      startMs: seventhStartMs,
      endMs: offset(),
      actionEndMs: seventhActionEndMs,
    });
    await shot(8, async () => {
      const panel = page.getByTestId("side-panel");
      await expect(panel.getByPlaceholder("Name this routine")).toHaveValue("Morning checklist");
      await expect(panel.getByText("Done", { exact: true })).toBeVisible();
      await expect(panel.locator("time")).toHaveCount(1);
    });
  } finally {
    await context.close();
  }
  if (!video || !processingCut || shots.length !== 8)
    throw new Error("Recording did not complete all eight shots.");
  await rename(await video.path(), path.join(outputDir, "routines-demo.webm"));
  await writeFile(
    path.join(outputDir, "routines-demo.shots.json"),
    `${JSON.stringify({ recordingStartEpochMs: startedAt, shots, processingCut }, null, 2)}\n`,
  );
});
