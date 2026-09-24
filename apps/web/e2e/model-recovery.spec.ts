import type { Bot, Me, ModelCatalogEntry } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("an unbound legacy pin asks which connection to use", async ({ page }, testInfo) => {
  await signup(page, `legacy-pin-${Date.now()}@ardurbot.test`, "password12", "Legacy Pin");
  await completeOnboarding(page);
  await page.route("**/rpc/bots/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Bot[] };
    body.json = body.json.map((bot) => ({
      ...bot,
      modelProvider: "xai",
      modelId: "grok-4.6",
      modelCredentialId: null,
      modelPinRevision: 0,
      thinkingLevel: null,
    }));
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/models/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "xai",
            providerName: "xAI",
            id: "grok-4.6",
            label: "Grok 4.6",
            auth: "api-key",
            billing: "",
            reasoning: true,
            thinkingLevels: ["low", "medium", "high"],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "first",
            provider: "xai",
            label: "First connection",
            hasKey: true,
            isDefault: true,
          },
          {
            id: "second",
            provider: "xai",
            label: "Second connection",
            hasKey: true,
            isDefault: false,
          },
        ],
      },
    }),
  );
  await page.reload();
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Chief/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Model & effort", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  const model = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toHaveValue("xai::grok-4.6");
  await expect(model.locator("option:checked")).toHaveText(
    "xai · grok-4.6 (not available on your account)",
  );
  await expect(
    settings.getByText("This bot's connection needs to be chosen. Pick the connection to use."),
  ).toBeVisible();
  await expect(model).toContainText("First connection · Grok 4.6");
  await expect(model).toContainText("Second connection · Grok 4.6");
  await captureScreenshot(page, testInfo, "legacy-pin-connection-choice");
});

test("the model chip and provider error open the bot model control", async ({ page }, testInfo) => {
  await signup(page, `model-recovery-${Date.now()}@ardurbot.test`, "password12", "Model Recovery");
  await completeOnboarding(page);

  const catalog: ModelCatalogEntry[] = [
    { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark" },
    { id: "gpt-6-sol", label: "GPT-6 Sol" },
    { id: "gpt-6-astra", label: "GPT-6 Astra" },
  ].map((entry) => ({
    ...entry,
    provider: "openai-codex",
    providerName: "OpenAI Codex",
    auth: "oauth",
    billing: "",
    reasoning: true,
    thinkingLevels: ["low", "medium", "high", "xhigh"],
  }));
  await page.route("**/rpc/models/list", (route) => route.fulfill({ json: { json: catalog } }));
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "test-credential",
            provider: "openai-codex",
            label: "Codex",
            hasKey: true,
            isDefault: true,
            modelId: "gpt-5.3-codex-spark",
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Me };
    await route.fulfill({
      response,
      json: {
        json: {
          ...body.json,
          defaultProvider: "openai-codex",
          defaultModel: "gpt-6-astra",
        },
      },
    });
  });
  await page.reload();
  const chip = page.getByRole("button", {
    name: "Change model: Codex · GPT-6 Astra · medium",
    exact: true,
  });
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("default");
  await captureScreenshot(page, testInfo, "chat-model-chip");
  await chip.click();
  const settings = page.getByTestId("bot-settings");
  const model = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toBeFocused();
  await expect(model.locator("option")).toHaveText([
    "Space default (GPT-6 Astra)",
    "OpenAI Codex · GPT-6 Astra",
    "OpenAI Codex · GPT-6 Sol",
  ]);
  await expect(settings.getByRole("combobox", { name: "Thinking", exact: true })).toBeVisible();
  await expect(
    settings.getByRole("combobox", { name: "Thinking", exact: true }).locator("option"),
  ).toContainText([
    "Default",
    "low — quick",
    "medium — balances",
    "high — slower",
    "xhigh — very slow",
  ]);
  await settings.getByLabel("Show all models").check();
  await expect(model.locator("option").last()).toContainText("May not be available on your plan");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .getByTestId("side-panel")
      .evaluate((node) => getComputedStyle(node).transitionProperty),
  ).not.toContain("width");
  await captureScreenshot(page, testInfo, "bot-model-control-focused");
  await page.getByRole("button", { name: "Close panel", exact: true }).click();

  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Chief/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Model & effort", exact: true }).click();
  await expect(model).toBeFocused();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();

  const message =
    "The 'gpt-5.3-codex-spark' model is not supported when using Codex with a ChatGPT account.";
  await page.route("**/rpc/threads/send", (route) =>
    route.fulfill({
      status: 400,
      json: {
        json: {
          defined: false,
          code: "BAD_REQUEST",
          status: 400,
          message: JSON.stringify({ detail: message }),
        },
      },
    }),
  );
  await page.getByPlaceholder(/^Message /).fill("Test model recovery");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const error = page.getByTestId("composer-error");
  await expect(error).toContainText(message);
  await expect(error).not.toContainText('{"detail"');
  await captureScreenshot(page, testInfo, "provider-model-error-recovery");
  await error.getByRole("button", { name: "Change model", exact: true }).click();
  await expect(model).toBeFocused();
});

test("a pin failure opens its provider settings and the bot model control", async ({
  page,
}, testInfo) => {
  await signup(page, `pin-recovery-${Date.now()}@ardurbot.test`, "password12", "Pin Recovery");
  await completeOnboarding(page);
  await page.route("**/rpc/models/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "xai",
            providerName: "xAI",
            id: "grok-4.6",
            label: "Grok 4.6",
            auth: "api-key",
            billing: "",
            reasoning: true,
            thinkingLevels: ["low", "medium", "high"],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/threads/get", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const pin = {
      provider: "xai",
      modelId: "grok-4.6",
      effort: "high",
      credentialId: "deleted",
      revision: 1,
    };
    body.json.run = {
      id: "pin-failed",
      botId: body.json.botId,
      threadId: body.json.threadId,
      taskId: "pin-task",
      status: "failed",
      trigger: "user",
      routineId: null,
      modelProvider: pin.provider,
      modelId: pin.modelId,
      runtimePin: pin,
      error: "Pinned connection missing",
      runtimeProblem: {
        kind: "problem",
        code: "pin-credential-missing",
        pin,
        reason: "The connection was deleted.",
        actions: ["connect", "change-pin"],
      },
      startedAt: null,
      completedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
    };
    await route.fulfill({ response, json: body });
  });
  await page.reload();
  const error = page.getByTestId("composer-error");
  await expect(error).toContainText(
    "This bot is pinned to xAI · Grok 4.6 · high; connect it or change the pin.",
  );
  await captureScreenshot(page, testInfo, "pin-failure-recovery");
  await error.getByRole("button", { name: "Change pin", exact: true }).click();
  await expect(
    page.getByTestId("bot-settings").getByRole("combobox", { name: "Model", exact: true }),
  ).toBeFocused();
  await page.getByRole("button", { name: "Close panel", exact: true }).click();
  await error.getByRole("button", { name: "Connect", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Models", { exact: true }).first()).toBeVisible();
  await expect(dialog.getByText("xAI", { exact: true }).first()).toBeVisible();
  await captureScreenshot(page, testInfo, "pin-connect-provider");
});

test("native runtime settings show unavailable sign-in without replacing the pin", async ({
  page,
}, testInfo) => {
  await signup(page, `native-runtime-${Date.now()}@ardurbot.test`, "password12", "Runtime Test");
  await completeOnboarding(page);
  await page.route("**/rpc/bots/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Bot[] };
    body.json = body.json.map((bot) => ({
      ...bot,
      runtimeKind: "claude-code",
      runtimeExperimental: false,
      modelProvider: "anthropic",
      modelId: "claude-opus-5",
      modelCredentialId: "native:claude-code",
      thinkingLevel: "low",
    }));
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/runtimes/availability", (route) =>
    route.fulfill({
      json: {
        json: {
          runtimeKind: "claude-code",
          available: false,
          reason: "Not signed in — run `claude` in a terminal once",
          models: [{ id: "claude-opus-5", label: "Opus 5", efforts: ["low"] }],
        },
      },
    }),
  );
  await page.reload();
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: /Chief/ })
    .first()
    .click({ button: "right" });
  await page.getByRole("menuitem", { name: "Model & effort", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("combobox", { name: "Runs on", exact: true })).toHaveValue(
    "claude-code",
  );
  await expect(settings.getByRole("combobox", { name: "Model", exact: true })).toHaveValue(
    "claude-opus-5",
  );
  await expect(settings.getByText("Not signed in — run `claude` in a terminal once")).toBeVisible();
  await expect(
    settings.getByRole("switch", { name: "Experimental", exact: true }),
  ).not.toBeChecked();
  await captureScreenshot(page, testInfo, "native-runtime-sign-in");
});
