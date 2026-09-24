import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("Ollama settings discover installed models without an API key or manual model id", async ({
  page,
}, testInfo) => {
  await signup(page, `ollama-${Date.now()}@ardurbot.test`, "password12", "Local models");
  await completeOnboarding(page);
  const status = {
    baseUrl: "http://127.0.0.1:11434",
    canPull: true,
    credentialId: "connection",
    version: "test-version",
    models: [
      {
        id: "qwen3:8b",
        parameterSize: "8.2B",
        reasoning: true,
        acceptsImages: false,
        supportsThinkingOff: true,
        contextWindow: 40960,
      },
    ],
  };
  await page.route("**/rpc/models/ollama", (route) => route.fulfill({ json: { json: status } }));
  await page.route("**/rpc/models/testOllama", (route) =>
    route.fulfill({ json: { json: status } }),
  );
  await openUserSettings(page, "models");
  await page.getByPlaceholder("Search providers").fill("ollama");
  await page.getByRole("button", { name: /Ollama/ }).click();
  await expect(page.getByLabel("Ollama server URL")).toHaveValue(status.baseUrl);
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByText("Ollama test-version", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Installed models")).toHaveValue("qwen3:8b");
  await expect(page.getByLabel("API key", { exact: true })).toHaveCount(0);
  await page.getByText("Pull model", { exact: true }).click();
  await expect(page.getByLabel("Model name")).toBeVisible();
  await captureScreenshot(page, testInfo, "ollama-installed-models");
  await page.unroute("**/rpc/models/testOllama");
  await page.route("**/rpc/models/testOllama", (route) =>
    route.fulfill({
      json: {
        json: {
          ...status,
          models: [],
          version: undefined,
          issue: "Ollama is not running. Start it and try again.",
        },
      },
    }),
  );
  await page.getByRole("button", { name: "Test", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Ollama is not running. Start it and try again.",
  );
  await captureScreenshot(page, testInfo, "ollama-not-running");
});
