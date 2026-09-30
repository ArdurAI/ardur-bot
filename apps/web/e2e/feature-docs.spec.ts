import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { listPiCatalog } from "../../../packages/adapters/src/pi-models";
import { dashboardFixture } from "./dashboard-fixture";
import {
  computerDocsFixture,
  groupGoalDocsFixture,
  integrationDocsFixture,
  memoryDocsFixture,
  routineDocsFixture,
} from "./feature-docs-fixtures";
import { openWorkspaceView } from "./workspace-view";

const captureRoot = process.env.FEATURE_DOCS_DIR
  ? Promise.resolve(process.env.FEATURE_DOCS_DIR)
  : mkdtemp(path.join(tmpdir(), "feature-docs-"));
const fixtureTime = new Date("2026-09-24T12:00:30.000Z");

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "en-US",
  timezoneId: "UTC",
});

async function capture(page: Page, id: string): Promise<void> {
  await expect(page.getByText("Loading…", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Loading model catalog…", { exact: true })).toHaveCount(0);
  const directory = path.join(await captureRoot, "docs");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.png`);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage: false });
  expect(
    (await stat(file)).size,
    `${id} exceeds the 250 KB documentation budget`,
  ).toBeLessThanOrEqual(250_000);
}

/** Check the visible header before a scenario opens any overlay or leaves the bot page. */
async function expectModelReady(page: Page) {
  const chip = page.getByRole("button", { name: /^Change model: / }).first();
  await expect(chip).toBeVisible();
  await expect(chip).not.toContainText("not available");
}

type DocsScenario = {
  botCount?: number;
  botNames?: string[];
  groups?: Record<string, unknown>[];
  routines?: Record<string, unknown>[];
  rpc?: (procedure: string, input?: Record<string, unknown>) => unknown;
};

async function useDashboard(page: Page, scenario: DocsScenario = {}) {
  const fixture = dashboardFixture(scenario.botCount ?? 1);
  const base = fixture.rpc("bootstrap") as Record<string, unknown>;
  const catalog = listPiCatalog();
  // A current model that supports the bot's medium thinking level, so the header never reads
  // "not available" in a published capture.
  const preferred = ["openai/gpt-5.2", "openai/gpt-5.1", "google/gemini-2.5-flash"];
  const connected =
    preferred
      .map((id) =>
        catalog.find(
          (entry) => entry.provider === "openrouter" && entry.id === id && entry.auth !== "oauth",
        ),
      )
      .find(Boolean) ??
    catalog.find(
      (entry) =>
        entry.provider === "openrouter" &&
        entry.auth !== "oauth" &&
        entry.thinkingLevels.includes("medium"),
    );
  const unconnected = catalog.find(
    (entry) => entry.provider !== connected?.provider && entry.auth === "api-key",
  );
  if (!connected || !unconnected) throw new Error("Bundled connection fixtures are unavailable.");
  const credential = {
    id: "docs-connection",
    provider: connected.provider,
    label: "Personal connection",
    hasKey: true,
    isDefault: true,
    modelId: connected.id,
  };
  const me = {
    ...(base.me as Record<string, unknown>),
    defaultProvider: connected.provider,
    defaultModel: connected.id,
  };
  const initialBot = {
    ...(base.bots as Record<string, unknown>[])[0]!,
    modelProvider: connected.provider,
    modelId: connected.id,
    modelCredentialId: credential.id,
    thinkingLevel: "medium",
  };
  const bots = [
    initialBot,
    ...(base.bots as Record<string, unknown>[]).slice(1).map((bot, index) => ({
      ...bot,
      name: scenario.botNames?.[index] ?? bot.name,
      modelProvider: connected.provider,
      modelId: connected.id,
      modelCredentialId: credential.id,
      thinkingLevel: "medium",
    })),
  ];
  const groups = scenario.groups ?? [];
  const space = { ...(base.spaces as Record<string, unknown>[])[0]!, bots, groups };
  await page.clock.setFixedTime(fixtureTime);
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    const input = route.request().postDataJSON()?.json as Record<string, unknown> | undefined;
    let value: unknown;
    const scenarioValue = scenario.rpc?.(procedure, input);
    if (scenarioValue !== undefined) value = scenarioValue;
    else if (procedure === "models/list") value = catalog;
    else if (procedure === "models/credentials") value = [credential];
    else if (procedure === "me") value = me;
    else if (procedure === "bots/create") {
      value = { ...initialBot, ...input, id: "new-bot", name: "Planner", threadId: "new-thread" };
      bots.unshift(value as Record<string, unknown>);
    } else if (procedure === "bots/list") value = bots;
    else if (procedure === "bots/get")
      value = bots.find((bot) => bot.id === input?.botId) ?? bots[0];
    else if (procedure === "bootstrap")
      value = { ...base, me, bots, groups, routines: scenario.routines ?? [], spaces: [space] };
    else if (procedure === "spaces/list") value = { current: space, spaces: [space] };
    else if (procedure === "groups/list") value = groups;
    else if (
      (procedure === "threads/get" || procedure === "threads/head") &&
      input?.botId === "new-bot"
    )
      value = {
        botId: "new-bot",
        threadId: "new-thread",
        cursor: 0,
        olderCursor: null,
        run: null,
        messages: [],
      };
    else if (procedure === "threads/answer") {
      value = fixture.rpc("threads/answer", input);
    } else value = fixture.rpc(procedure, input);
    await route.fulfill({ json: { json: value } });
  });
  return { fixture, catalog, connected, unconnected };
}

test("sign-in: open the form and recovery route", async ({ page }) => {
  await page.clock.setFixedTime(fixtureTime);
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { passwordReset: true, resetUrl: null } }),
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Ardur" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await capture(page, "docs-sign-in-open");
  await page.route("**/api/auth/sign-in/email", (route) => route.abort());
  await page.getByRole("textbox", { name: "Email" }).fill("reader@example.test");
  await page.getByLabel("Password", { exact: true }).fill("fixture-password");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await expect(page.getByRole("alert")).toHaveText("Could not reach the server");
  await capture(page, "docs-sign-in-error");
  const recovery = page.getByRole("link", { name: "Forgot password?" });
  await expect(recovery).toBeVisible();
  await recovery.click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
  await capture(page, "docs-sign-in-recovery");
});

test("onboarding: prepare a required connection", async ({ page }) => {
  const { fixture, connected } = await useDashboard(page);
  const me = fixture.rpc("me") as Record<string, unknown>;
  await page.route("**/rpc/me", (route) =>
    route.fulfill({
      json: {
        json: {
          ...me,
          needsModel: true,
          defaultProvider: "openrouter",
          defaultModel: connected.id,
        },
      },
    }),
  );
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Provider" })).toBeVisible();
  const key = page.getByLabel("API key", { exact: true });
  await expect(key).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
  await capture(page, "docs-onboarding-open");
  await key.fill("fixture-key");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled();
  await capture(page, "docs-onboarding-connect");
});

test("bots-create: select a computer mode before creating", async ({ page }) => {
  await useDashboard(page);
  await page.goto("/app/bot");
  await expectModelReady(page);
  const create = page.getByTestId("create-menu-trigger");
  await expect(create).toBeVisible();
  await create.click();
  const newBot = page.getByTestId("create-new-bot");
  await expect(newBot).toBeVisible();
  await capture(page, "docs-bots-create-open");
  await newBot.click();
  const form = page.getByTestId("create-bot-form");
  await expect(form).toBeVisible();
  await expect(form.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Private" })).toBeVisible();
  await capture(page, "docs-bots-create-form");
  await form.getByRole("textbox", { name: "Name" }).fill("Planner");
  const privateMode = form.getByRole("button", { name: "Private" });
  await expect(privateMode).toBeVisible();
  await privateMode.click();
  await expect(privateMode).toHaveAttribute("aria-pressed", "true");
  await capture(page, "docs-bots-create-private");
  await form.getByRole("button", { name: "Create", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/new-bot$/);
  await expect(page.getByPlaceholder("Message Planner")).toBeVisible();
  await expect(form).toBeHidden();
  await expectModelReady(page);
  await capture(page, "docs-bots-create-ready");
});

test("models: inspect a connection, default control, and connection form", async ({ page }) => {
  const { connected, unconnected } = await useDashboard(page);
  await page.goto("/app/bot");
  await expectModelReady(page);
  const settings = page
    .locator("header.app-drag")
    .getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.click();
  const panel = page.getByTestId("user-settings");
  const models = panel.getByTestId("settings-nav-models");
  await expect(models).toBeVisible();
  await models.click();
  await expect(panel.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(panel.getByText("Connected · Personal connection")).toBeVisible();
  await expect(panel.getByText(connected.label, { exact: true }).first()).toBeVisible();
  await capture(page, "docs-models-open");
  const otherModel = panel.getByRole("combobox", { name: "Model", exact: true });
  await otherModel.click();
  const alternate = listPiCatalog().find(
    (entry) => entry.provider === connected.provider && entry.id !== connected.id,
  );
  if (!alternate) throw new Error("Bundled default-choice fixture is unavailable.");
  await panel.getByRole("option", { name: alternate.label }).first().click();
  const useThisModel = panel.getByRole("button", { name: "Use this model" });
  await expect(useThisModel).toBeVisible();
  await useThisModel.scrollIntoViewIfNeeded();
  await capture(page, "docs-models-default");
  await panel
    .getByRole("button", { name: unconnected.providerName ?? unconnected.provider })
    .click();
  const connectKey = panel.getByRole("button", { name: "Connect API key" });
  await expect(connectKey).toBeVisible();
  await expect(panel.getByLabel("API key", { exact: true })).toBeVisible();
  await connectKey.scrollIntoViewIfNeeded();
  await capture(page, "docs-models-add");
});

test("chat-approvals: inspect and deny a pending action", async ({ page }) => {
  const state = await useDashboard(page);
  await page.goto("/app/bot");
  await expectModelReady(page);
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(deny).toBeVisible();
  await capture(page, "docs-chat-approvals-pending");
  await deny.click();
  await expect.poll(() => state.fixture.approvedInput).toMatchObject({ answer: "deny" });
  await expect.poll(() => (state.fixture.rpc("threads/head") as { run: unknown }).run).toBeNull();
  await expect(page.getByText("Denied", { exact: true })).toBeVisible();
  await expect(deny).toBeHidden();
  await expect(page.getByRole("button", { name: "Sending…" })).toBeHidden();
  await capture(page, "docs-chat-approvals-denied");
});

test("routines: edit a scheduled routine and inspect its result", async ({ page }) => {
  const state = routineDocsFixture();
  await useDashboard(page, state);
  await page.goto("/app/bot");
  await expectModelReady(page);
  await page.getByTitle("Agent computer").click();
  await openWorkspaceView(page, "Routines");
  await expect(page.getByRole("button", { name: /Morning brief/ })).toBeVisible();
  await capture(page, "docs-routines-open");
  await page.getByRole("button", { name: /Morning brief/ }).click();
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-panel", "routine");
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Morning brief");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("Summarize the revised sample plan.");
  const routineHelp = panel.getByRole("link", { name: "Learn more about Routines" });
  await expect(routineHelp).toHaveAttribute(
    "href",
    "https://ardur.ai/docs/features/routines/#step-edit-routine-instruction",
  );
  await expect(routineHelp).toHaveAttribute("target", "_blank");
  await page.context().route("https://ardur.ai/docs/features/**", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<title>Documentation</title>",
    }),
  );
  const [docsTab] = await Promise.all([page.waitForEvent("popup"), routineHelp.click()]);
  await docsTab.close();
  await expect(page.locator("label:has-text('Instruction') textarea")).toHaveValue(
    "Summarize the revised sample plan.",
  );
  await capture(page, "docs-routines-edit");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.current.prompt).toBe("Summarize the revised sample plan.");
  await expect(page.getByLabel("How often")).toHaveValue("Weekdays");
  await expect(page.getByRole("button", { name: "Test run" })).toBeEnabled();
  await capture(page, "docs-routines-saved");
  await page.getByRole("button", { name: "Test run" }).click();
  await expect(panel.getByText("Run history")).toBeVisible();
  await expect(panel.getByText("Done", { exact: true })).toBeVisible();
  await capture(page, "docs-routines-result");
});

test("memory-documents: inspect history and approve a reviewed change", async ({ page }) => {
  const state = memoryDocsFixture();
  await useDashboard(page, state);
  await page.goto("/app/bot");
  await expectModelReady(page);
  await page
    .locator("header.app-drag")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-nav-memory").click();
  const memory = settings.getByTestId("memory-settings-page");
  await expect(memory.getByRole("button", { name: /Preferences.*Updated/ })).toBeVisible();
  await capture(page, "docs-memory-documents-open");
  await memory.getByRole("button", { name: /Preferences.*Updated/ }).click();
  const document = memory.getByRole("region", { name: "Memory document" });
  await expect(document.getByText("Use concise answers.", { exact: true }).first()).toBeVisible();
  await capture(page, "docs-memory-documents-detail");
  await document.getByText("History", { exact: true }).click();
  const firstRevision = document
    .getByTestId("memory-history")
    .getByRole("button", { name: "Revision 1" });
  await expect(firstRevision).toBeVisible();
  // Bring the document card to the top of the settings panel so the revision is readable.
  await document.evaluate((element) => element.scrollIntoView({ block: "start" }));
  await expect(firstRevision).toBeInViewport();
  await capture(page, "docs-memory-documents-history");
  await memory
    .getByLabel("Tell your bot what to change or remove")
    .fill("Cite sources in answers.");
  await memory.getByRole("button", { name: "Send", exact: true }).click();
  const suggestions = memory.getByRole("region", { name: "Memory suggestions" });
  await expect(suggestions.getByRole("button", { name: "Approve" })).toBeVisible();
  await suggestions.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => state.approved).toBe(true);
  await expect(
    document.getByText("Use concise answers and cite sources.", { exact: true }).first(),
  ).toBeVisible();
  await capture(page, "docs-memory-documents-change");
});

test("computers: inspect capacity, connection form, and test outcomes", async ({ page }) => {
  const state = computerDocsFixture();
  await useDashboard(page, state);
  await page.goto("/app/bot");
  await expectModelReady(page);
  await page
    .locator("header.app-drag")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-nav-computer").click();
  const fleet = settings.getByTestId("fleet-settings");
  await expect(fleet).toContainText("24.0 GB free");
  const row = fleet.locator('[data-fleet-target="workshop"]');
  await expect(row).toContainText("Running");
  await capture(page, "docs-computers-open");
  await fleet.getByRole("button", { name: "Add computer", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add computer" });
  await expect(dialog.getByLabel("Connection type")).toBeVisible();
  await expect(dialog.getByLabel("Name")).toBeVisible();
  await capture(page, "docs-computers-add");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  state.setFail(true);
  await row.getByRole("button", { name: "Test" }).click();
  await expect(row).toContainText("Engine not reachable");
  await capture(page, "docs-computers-refused");
  state.setFail(false);
  await row.getByRole("button", { name: "Test" }).click();
  await expect(row).toContainText("Running");
  await capture(page, "docs-computers-tested");
});

test("integrations: inspect the catalog, tool access, and connection form", async ({ page }) => {
  const state = integrationDocsFixture();
  await useDashboard(page, state);
  await page.goto("/app/bot");
  await expectModelReady(page);
  await page
    .locator("header.app-drag")
    .getByRole("button", { name: "Settings", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await settings.getByTestId("settings-nav-integrations").click();
  await expect(settings.getByTestId("integration-notion")).toBeVisible();
  await capture(page, "docs-integrations-open");
  await settings.getByTestId("integration-notion").getByRole("button", { name: "Manage" }).click();
  const manage = settings.getByTestId("integration-manage");
  const permission = manage.getByRole("combobox", { name: "Permission for read_notes" });
  await expect(permission).toHaveValue("ask");
  await capture(page, "docs-integrations-access");
  await permission.selectOption("allow");
  await expect(permission).toHaveValue("allow");
  await capture(page, "docs-integrations-allow");
  await permission.selectOption("block");
  await manage.getByRole("button", { name: "Save", exact: true }).click();
  await expect.poll(() => state.connection.spaceAllowedTools).not.toContain("read_notes");
  await expect(permission).toHaveValue("block");
  await capture(page, "docs-integrations-block");
  await manage.getByRole("button", { name: "Back" }).click();
  await settings.getByTestId("integration-notion").getByRole("button", { name: "Manage" }).click();
  await expect(
    settings
      .getByTestId("integration-manage")
      .getByRole("combobox", { name: "Permission for read_notes" }),
  ).toHaveValue("block");
  await settings.getByTestId("integration-manage").getByRole("button", { name: "Back" }).click();
  await settings
    .getByTestId("integration-github")
    .getByRole("button", { name: "Use a token" })
    .click();
  await expect(settings.getByLabel("Fine-grained token")).toHaveAttribute("type", "password");
  await capture(page, "docs-integrations-connect");
});

test("group-goals: start a goal in a room and stop it", async ({ page }) => {
  const state = groupGoalDocsFixture();
  await useDashboard(page, {
    botCount: 2,
    botNames: ["Planner"],
    groups: [state.group],
    rpc: state.rpc,
  });
  await page.goto("/app/bot");
  await expectModelReady(page);
  await page.goto("/app/g/operations-group");
  for (const member of state.group.members) {
    const chip = page.getByTestId(`group-participant-${member.botId}`);
    await expect(chip).toBeVisible();
    await expect(chip.getByRole("status", { name: /^Using / })).toBeVisible();
    await expect(chip).not.toContainText("not available");
  }
  await page.getByTestId("bot-settings-trigger").click();
  const panel = page.getByTestId("side-panel");
  await expect(panel).toHaveAttribute("data-panel", "group-settings");
  await expect(panel.getByRole("textbox", { name: "Objective" })).toBeVisible();
  await capture(page, "docs-group-goals-ready");
  await panel.getByRole("textbox", { name: "Objective" }).fill("Review the sample release plan.");
  await panel
    .getByRole("textbox", { name: "Done when (one per line)" })
    .fill("The plan has an independent check.");
  await expect(panel.getByRole("button", { name: "Start goal" })).toBeEnabled();
  await capture(page, "docs-group-goals-form");
  await panel.getByRole("button", { name: "Start goal" }).click();
  await expect.poll(() => state.goal?.status, { timeout: 3_000 }).toBe("running");
  await expect(page.getByText("Goal: Working", { exact: false })).toBeVisible();
  await expect(panel).toHaveAttribute("data-panel", "closed");
  await capture(page, "docs-group-goals-progress");
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await expect.poll(() => state.goal?.status, { timeout: 3_000 }).toBe("stopped");
  await expect(page.getByText("Goal: Stopped", { exact: false })).toBeVisible();
  await capture(page, "docs-group-goals-stopped");
});
