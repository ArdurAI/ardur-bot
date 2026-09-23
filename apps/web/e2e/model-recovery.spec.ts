import type { Me, ModelCatalogEntry } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

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
    name: "Change model: GPT-6 Astra · medium",
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
  await captureScreenshot(page, testInfo, "bot-model-control-focused");
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
