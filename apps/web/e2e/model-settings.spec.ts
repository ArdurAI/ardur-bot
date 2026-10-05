import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, rpc, signup } from "./helpers";

const LOCAL_MODEL_ID = "ardurbot-e2e-local";
const LOCAL_MODEL_REPLY = "OpenAI-compatible endpoint verified end to end.";

test("runtime reliability keeps cancellations separate and textless results unmeasured", async ({
  page,
}, testInfo) => {
  await signup(page, `reliability-${Date.now()}@example.test`, "password12", "Reliability fixture");
  await completeOnboarding(page);
  await page.route("**/rpc/runtimes/reliability", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          from: "2030-01-01T00:00:00Z",
          asOf: "2030-01-08T00:00:00Z",
          runtimes: [
            {
              runtimeKind: "pi",
              completed: 2,
              failed: 1,
              cancelled: 1,
              successRate: 2 / 3,
              measuredRuns: 2,
              firstReplyMedianMs: 2500,
              lastFailure: { category: "usage-limit", at: "2030-01-08T00:00:00Z" },
            },
            {
              runtimeKind: "codex-app-server",
              completed: 0,
              failed: 0,
              cancelled: 1,
              successRate: null,
              measuredRuns: 0,
              firstReplyMedianMs: null,
              lastFailure: null,
            },
          ],
        },
      }),
    }),
  );
  await openUserSettings(page, "models");
  await page.locator("summary", { hasText: "Last 7 days" }).click();
  const builtIn = page.getByRole("region", { name: "Ardur", exact: true });
  await expect(builtIn.getByText("67%", { exact: true })).toBeVisible();
  await expect(builtIn.getByText("2 measured runs", { exact: true })).toBeVisible();
  await expect(
    builtIn.getByText("Ardur's usage limit is reached.", { exact: false }),
  ).toBeVisible();
  await expect(
    page
      .getByRole("region", { name: "Codex", exact: true })
      .getByText("Not measured", { exact: true }),
  ).toHaveCount(2);
  await captureScreenshot(page, testInfo, "runtime-reliability");
});

test("native discovery and cancelled connection preserve the default pin", async ({
  page,
}, testInfo) => {
  await signup(page, `native-models-${Date.now()}@example.test`, "password12", "Native models");
  await completeOnboarding(page);
  const original = await rpc<Record<string, unknown>>(page, "me", {});
  await page.route("**/rpc/me", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ...original, isDeploymentOwner: true } }),
    }),
  );
  await page.route("**/rpc/runtimes/availability", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          runtimeKind: "codex-app-server",
          available: true,
          signedIn: false,
          models: [{ id: "fixture-native", label: "Fixture native", efforts: [] }],
        },
      }),
    }),
  );
  await page.route("**/rpc/runtimes/connectCodex", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fixture-login",
          mode: "auth-url",
          verificationUri: "https://example.test/login",
        },
      }),
    }),
  );
  await page.route("**/rpc/runtimes/cancelConnect", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { ok: true } }),
    }),
  );
  await openUserSettings(page, "models");
  await page.getByText("Native runtimes", { exact: true }).click();
  await page
    .locator("summary")
    .filter({ hasText: /^Codex$/ })
    .click();
  await expect(page.getByText("Fixture native", { exact: true })).toBeVisible();
  const codex = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Codex$/ }) });
  await codex.locator("summary", { hasText: "Capability checks" }).click();
  const checks = codex.locator("dl dd");
  await expect(checks).toHaveCount(5);
  for (const check of await checks.all()) await expect(check).toContainText("Not tested");
  await expect(checks.first()).toContainText("Declared");
  await expect(codex.getByText("Confirmed offline", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "runtime-capability-checks");
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue with ChatGPT" })).toBeVisible();
  await captureScreenshot(page, testInfo, "native-models-connection");
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("link", { name: "Continue with ChatGPT" })).toHaveCount(0);
  const current = await rpc<Record<string, unknown>>(page, "me", {});
  expect(current.defaultModel).toBe(original.defaultModel);
});

test("Anthropic offers API keys and asks old subscription connections to reconnect", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `anthropic-key-${stamp}@example.test`, "password12", "API key connection");
  await completeOnboarding(page);
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "legacy-connection",
            provider: "anthropic",
            label: "Old subscription",
            hasKey: false,
            isDefault: false,
            connectionIssue: "api-key-required",
          },
        ],
      }),
    }),
  );
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("anthropic");
  await page.getByRole("button", { name: /Anthropic/ }).click();
  await expect(page.getByText("Set up on the home device")).toBeVisible();
  await expect(page.getByText("Reconnect with an API key", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Sign in/ })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Use this model", exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "anthropic-api-key-reconnect");
  await page.unroute("**/rpc/models/credentials");
  await page.getByLabel("API key", { exact: true }).fill("fake-anthropic-api-key");
  await page.getByRole("button", { name: "Connect API key", exact: true }).click();
  await expect(page.getByLabel("Replace API key", { exact: true })).toBeVisible();
  await expect(page.getByText("Reconnect with an API key", { exact: true })).toBeHidden();
  await captureScreenshot(page, testInfo, "anthropic-api-key-connected");
});

test("custom connections persist reasoning support and bot thinking", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  const userName = `Reasoning ${stamp}`;
  await signup(page, `reasoning-model-${stamp}@example.test`, "password12", userName);
  await completeOnboarding(page);
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("openai-compatible");
  await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await page.getByLabel("OpenAI-compatible server URL").fill("http://127.0.0.1:8090/v1");
  await page.getByLabel("Model id").fill("arbitrary-model");
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeHidden();
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeHidden();
  await page.getByText("Advanced", { exact: true }).click();
  await page.getByRole("checkbox", { name: "Supports thinking" }).check();
  await page.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("low");
  await page.getByLabel("Maximum output tokens").fill("8192");
  await page.getByLabel("Context limit").fill("65536");
  await page.getByRole("checkbox", { name: "Supports images" }).check();
  await page.getByLabel("Maximum images per request").fill("1");
  await captureScreenshot(page, testInfo, "openai-compatible-thinking-connection");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const credentials = await rpc<
    Array<{
      modelId?: string;
      reasoning?: boolean;
      thinkingLevel?: string | null;
      maxTokens?: number;
      contextWindow?: number;
      supportsImages?: boolean;
      maxImagesPerPrompt?: number;
    }>
  >(page, "models/credentials", {});
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.reasoning).toBe(true);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.thinkingLevel).toBe(
    "low",
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxTokens).toBe(8192);
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.contextWindow).toBe(
    65536,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.supportsImages).toBe(
    true,
  );
  expect(credentials.find((entry) => entry.modelId === "arbitrary-model")?.maxImagesPerPrompt).toBe(
    1,
  );
  await page.reload();
  await openUserSettings(page, "models");
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByRole("checkbox", { name: "Supports thinking" })).toBeChecked();
  await expect(page.getByRole("combobox", { name: "Reasoning effort", exact: true })).toHaveValue(
    "low",
  );
  await expect(page.getByLabel("Maximum output tokens")).toHaveValue("8192");
  await expect(page.getByLabel("Context limit")).toHaveValue("65536");
  await expect(page.getByRole("checkbox", { name: "Supports images" })).toBeChecked();
  await expect(page.getByLabel("Maximum images per request")).toHaveValue("1");
  await page.getByLabel("Maximum images per request").fill("");
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await expect(page.getByText("Saved.", { exact: true })).toBeVisible();
  const clearedCredentials = await rpc<Array<{ modelId?: string; maxImagesPerPrompt?: number }>>(
    page,
    "models/credentials",
    {},
  );
  expect(
    clearedCredentials.find((entry) => entry.modelId === "arbitrary-model")?.maxImagesPerPrompt,
  ).toBeUndefined();
  await page.getByRole("button", { name: "Close model settings" }).click();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const settings = page.getByTestId("bot-settings");
  await expect(settings).toBeVisible();
  const advanced = settings.getByTestId("bot-settings-advanced");
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  // NativeSelect sits inside a wrapping <label>, so label text includes option
  // copy and getByLabel(..., { exact: true }) misses the control. Use the
  // combobox accessible name, matching other model E2E tests.
  const model = settings.getByRole("combobox", { name: "Model", exact: true });
  await expect(model).toBeVisible();
  await expect(model).toContainText("arbitrary-model");
  // Value key — not a /arbitrary-model/ label match, which also hits "Space default (arbitrary-model)".
  await model.selectOption({ label: "OpenAI-compatible · arbitrary-model" });
  const thinking = settings.getByRole("combobox", { name: "Thinking", exact: true });
  await expect(thinking).toBeVisible();
  await thinking.selectOption("low");
  await thinking.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "openai-compatible-thinking");
  const saved = page.waitForResponse(
    (response) => response.url().includes("/rpc/bots/update") && response.ok(),
  );
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await saved;
  await page.reload();
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  await expect(settings).toBeVisible();
  await advanced.evaluate((element) => {
    (element as HTMLDetailsElement).open = true;
  });
  await expect(thinking).toHaveValue("low");
});

test("connects, lists, and uses an OpenAI-compatible endpoint", async ({ page }, testInfo) => {
  const server = createServer((request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: LOCAL_MODEL_ID }] }));
      return;
    }
    if (request.method === "POST" && request.url === "/v1/chat/completions") {
      response.writeHead(200, {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream",
      });
      const created = Math.floor(Date.now() / 1_000);
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-ardurbot-e2e",
          object: "chat.completion.chunk",
          created,
          model: LOCAL_MODEL_ID,
          choices: [
            {
              index: 0,
              delta: { role: "assistant", content: LOCAL_MODEL_REPLY },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      response.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-ardurbot-e2e",
          object: "chat.completion.chunk",
          created,
          model: LOCAL_MODEL_ID,
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: { prompt_tokens: 4, completion_tokens: 6, total_tokens: 10 },
        })}\n\n`,
      );
      response.end("data: [DONE]\n\n");
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  try {
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/v1`;
    const stamp = Date.now();
    const userName = `Local model ${stamp}`;
    await signup(page, `local-model-${stamp}@example.test`, "password12", userName);
    await completeOnboarding(page);

    await openUserSettings(page, "models");
    const providerSearch = page.getByPlaceholder("Search providers");
    await providerSearch.fill("openai-compatible");
    await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeVisible();
    await page.getByText("Setup help", { exact: true }).click();
    await expect(
      page.getByText("Paste the OpenAI-compatible address", { exact: false }),
    ).toBeHidden();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await page.getByLabel("Model id").fill("manual-model-not-listed");
    await page.getByRole("button", { name: "Find models" }).click();

    await expect(page.getByLabel("Model id")).toHaveValue("manual-model-not-listed");
    await page.getByRole("button", { name: "Use a found model" }).click();
    const discoveredModels = page.getByRole("combobox", { name: "Models from server" });
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await discoveredModels.selectOption("");
    await expect(page.getByLabel("Model id")).toBeVisible();
    await page.getByRole("button", { name: "Find models" }).click();
    await expect(discoveredModels).toHaveValue(LOCAL_MODEL_ID);
    await expect(page.getByText("Found 1 model.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
    await captureScreenshot(page, testInfo, "openai-compatible-model-discovery");

    await page.getByRole("button", { name: "Save" }).click();
    await expect(page.getByText("Saved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /OpenAI-compatible/ })).toContainText(
      "Connected",
    );
    await captureScreenshot(page, testInfo, "openai-compatible-connected");

    await page.getByLabel("OpenAI-compatible server URL").fill("");
    await expect(page.getByRole("button", { name: "Find models" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
    await page.getByLabel("OpenAI-compatible server URL").fill(baseUrl);
    await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();

    if (process.env.AGENT_RUNTIME === "pi") {
      await page.getByRole("button", { name: "Close model settings" }).click();
      const composer = page.getByPlaceholder(/Message/);
      await composer.fill("Reply with the endpoint verification message.");
      await page.keyboard.press("Enter");
      await expect(page.getByTestId("transcript").getByText(LOCAL_MODEL_REPLY)).toBeVisible({
        timeout: 30_000,
      });
      await captureScreenshot(page, testInfo, "openai-compatible-response");
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("model settings connect, replace, and cancel provider authentication", async ({ page }) => {
  const stamp = Date.now();
  const userName = `Models ${stamp}`;
  await signup(page, `models-${stamp}@example.test`, "password12", userName);
  await completeOnboarding(page);

  await openUserSettings(page, "models");
  await expect(page.getByRole("button", { name: "Close model settings" })).toBeVisible();

  const providerSearch = page.getByPlaceholder("Search providers");
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await expect(
    page.getByTestId("model-settings").getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveText(/Scripted runtime/);
  const apiKeyInput = page.getByLabel("API key");
  await expect(apiKeyInput).toHaveAttribute("autocomplete", "new-password");
  await apiKeyInput.fill("fake-scripted-key-one");
  await page.getByRole("button", { name: "Connect API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await page.getByLabel("Replace API key").fill("fake-scripted-key-two");
  await page.getByRole("button", { name: "Replace API key" }).click();
  await expect(page.getByText(/Connected and using Scripted runtime/)).toBeVisible();

  await page.route("**/rpc/models/beginOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: {
          loginId: "fake-login",
          provider: "openai-codex",
          mode: "device-code",
          verificationUri: "https://example.com/device",
          userCode: "TEST-CODE",
          expiresInSeconds: 900,
        },
      }),
    });
  });
  await page.route("**/rpc/models/completeOAuth", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: { status: "pending" } }),
    });
  });
  await page.evaluate(() => {
    window.open = () => null;
  });
  let finishRequests = 0;
  page.on("request", (request) => {
    if (request.url().includes("/rpc/models/finishOAuth")) finishRequests += 1;
  });

  await providerSearch.fill("openai-codex");
  await page
    .getByRole("button", { name: /ChatGPT Plus\/Pro/ })
    .first()
    .click();
  await page.getByRole("button", { name: /Sign in with ChatGPT Plus\/Pro/ }).click();
  await expect(page.getByText("Waiting for sign-in…")).toBeVisible();

  const cancelled = page.waitForRequest((request) =>
    request.url().includes("/rpc/models/cancelOAuth"),
  );
  await providerSearch.fill("scripted");
  await page.getByRole("button", { name: /Scripted/ }).click();
  await cancelled;
  expect(finishRequests).toBe(0);
  await page.getByLabel("Replace API key").fill("fake-scripted-key-three");
  await expect(page.getByRole("button", { name: "Replace API key" })).toBeEnabled();
  await expect(page.getByText("Waiting for sign-in…")).toBeHidden();
});

test("Models shows an unsaved context estimate and preserves its source", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `context-estimate-${stamp}@example.test`, "password12", "Context settings");
  await completeOnboarding(page);
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        json: [
          {
            id: "context-fixture",
            provider: "openai-compatible",
            label: "Fixture connection",
            hasKey: true,
            isDefault: false,
            modelId: "fixture-model",
            baseUrl: "https://example.invalid/v1",
            contextWindow: 65_536,
            contextWindowSource: "default",
          },
        ],
      }),
    }),
  );
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("openai-compatible");
  await page.getByRole("button", { name: /OpenAI-compatible/ }).click();
  await page.getByText("Advanced", { exact: true }).click();
  await expect(page.getByLabel("Context limit (estimated)", { exact: true })).toHaveValue("65536");
  await captureScreenshot(page, testInfo, "model-context-estimate");
  await page.getByLabel("Context limit (estimated)", { exact: true }).fill("64000");
  await expect(page.getByLabel("Context limit", { exact: true })).toHaveValue("64000");
  await captureScreenshot(page, testInfo, "model-context-explicit-limit");
});
