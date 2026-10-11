import { expect, test } from "@playwright/test";
import { captureScreenshot, signup } from "./helpers";

test("onboarding requires a model when the deployment has none", async ({ page }, testInfo) => {
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Record<string, unknown> };
    await route.fulfill({
      response,
      json: {
        json: {
          ...body.json,
          needsModel: true,
          defaultProvider: "openrouter",
          defaultModel: "openai/gpt-5.6-luna",
        },
      },
    });
  });

  const stamp = Date.now();
  await signup(
    page,
    `model-required-${stamp}@example.test`,
    "password12",
    `Model required ${stamp}`,
  );
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible({
    timeout: 20_000,
  });

  await expect(page.getByRole("button", { name: "Skip for now" })).toBeHidden();
  const continueButton = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("API key", { exact: true }).fill("   ");
  await expect(continueButton).toBeDisabled();
  await page.getByLabel("API key", { exact: true }).fill("fake-test-key");
  await expect(continueButton).toBeEnabled();
  await page.getByLabel("API key", { exact: true }).fill("");
  await captureScreenshot(page, testInfo, "onboarding-model-required");
});

for (const unavailable of ["empty", "failed"] as const) {
  test(`onboarding cannot continue with a ${unavailable} model catalog`, async ({ page }) => {
    await page.route("**/rpc/me", async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { json: Record<string, unknown> };
      await route.fulfill({ response, json: { json: { ...body.json, needsModel: true } } });
    });
    await page.route("**/rpc/models/list", (route) =>
      unavailable === "failed" ? route.abort() : route.fulfill({ json: { json: [] } }),
    );
    const stamp = Date.now();
    await signup(page, `catalog-${unavailable}-${stamp}@example.test`, "password12", "Model setup");
    if (unavailable === "failed") {
      await expect(page.getByRole("alert")).toContainText("Could not load models.");
      await expect(page.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Connect a model" })).toBeHidden();
    } else {
      await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    }
    await expect(page.getByRole("heading", { name: "Create your first bot" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: "Message Chief" })).toHaveCount(0);
  });
}

for (const failed of ["account", "catalog"] as const) {
  test(`onboarding stays open after ${failed} failure and recovers on retry`, async ({
    page,
  }, testInfo) => {
    let recovered = false;
    let created = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/rpc/bots/create")) created += 1;
    });
    await page.route("**/rpc/me", async (route) => {
      if (failed === "account" && !recovered) {
        await route.abort();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as { json: Record<string, unknown> };
      await route.fulfill({ response, json: { json: { ...body.json, needsModel: false } } });
    });
    if (failed === "catalog") {
      await page.route("**/rpc/models/list", (route) =>
        recovered ? route.fulfill({ json: { json: [] } }) : route.abort(),
      );
    }
    await page.route("**/rpc/integrationSetup/get", (route) =>
      route.fulfill({
        json: {
          json: {
            canConfigure: false,
            needsSetup: false,
            webUrl: "https://example.test/integrations/setup",
            providers: [],
          },
        },
      }),
    );
    const stamp = Date.now();
    await signup(page, `setup-retry-${failed}-${stamp}@example.test`, "password12", "Setup retry");
    await expect(page.getByRole("alert")).toContainText(
      failed === "account" ? "Could not load setup." : "Could not load models.",
    );
    await expect(page).toHaveURL(/\/onboarding$/);
    expect(created).toBe(0);
    await captureScreenshot(page, testInfo, `onboarding-${failed}-retry`);
    recovered = true;
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("combobox", { name: "Message Chief" })).toBeVisible({
      timeout: 20_000,
    });
    expect(created).toBe(1);
    await page.unrouteAll({ behavior: "wait" });
  });
}
