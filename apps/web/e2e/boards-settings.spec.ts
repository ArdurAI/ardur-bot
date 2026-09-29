import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("Boards settings save the chosen learning reviewer across a reload", async ({
  page,
}, testInfo) => {
  await signup(page, `boards-settings-${Date.now()}@ardurbot.test`, "password12", "Board owner");
  await completeOnboarding(page);

  let reviewerPin: Record<string, unknown> | null = {
    runtimeKind: "pi",
    provider: "openai",
    modelId: "model-a",
    credentialId: "cred",
    effort: "medium",
    revision: 1,
  };
  const budgets = {
    botDailyTokens: 30000,
    spaceDailyTokens: 150000,
    maxProposals: 3,
    timeoutMs: 30000,
    maxOutputTokens: 2000,
    maxOutputChars: 12000,
  };

  await page.route("**/rpc/board/workspaces", (route) =>
    route.fulfill({
      json: {
        json: {
          workspaces: [
            {
              id: "board",
              kind: "space",
              name: "Board",
              path: "/fixture/board",
              prefix: "board",
              enabled: true,
              initialized: true,
            },
          ],
          problem: null,
        },
      },
    }),
  );
  await page.route("**/rpc/bots/list", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/board/upkeep", (route) =>
    route.fulfill({ json: { json: { enabled: true } } }),
  );
  await page.route("**/rpc/learning/settings", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          consolidationEnabled: false,
          insightsEnabled: true,
          reviewerPin,
          budgets,
          destination: {
            runtimeKind: "pi",
            provider: "openai",
            modelId: "model-a",
            credentialId: "cred",
            effort: "medium",
            revision: 1,
          },
          canConfigure: true,
        },
      },
    }),
  );
  await page.route("**/rpc/learning/setReviewer", async (route) => {
    const body = route.request().postDataJSON() as {
      json: { expectedRevision: number; pin: Record<string, unknown> };
    };
    reviewerPin = { ...body.json.pin, revision: body.json.expectedRevision + 1 };
    await route.fulfill({
      json: {
        json: {
          enabled: true,
          consolidationEnabled: false,
          insightsEnabled: true,
          reviewerPin,
          budgets,
          destination: null,
          canConfigure: true,
        },
      },
    });
  });
  // Settings > Boards is owner-only, and the e2e user is not the deployment owner by default.
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, me: { ...body.json.me, isDeploymentOwner: true } } },
    });
  });
  await page.route("**/rpc/me", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, defaultProvider: "openai", defaultModel: "model-a" } },
    });
  });
  await page.route("**/rpc/models/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "openai",
            id: "model-a",
            label: "Model A",
            billing: "usage",
            thinkingLevels: ["medium", "high"],
          },
          {
            provider: "openai",
            id: "model-b",
            label: "Model B",
            billing: "usage",
            thinkingLevels: ["medium", "high"],
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/models/credentials", (route) =>
    route.fulfill({
      json: { json: [{ id: "cred", provider: "openai", label: "OpenAI" }] },
    }),
  );
  await page.route("**/rpc/runtimes/availability", (route) =>
    route.fulfill({ json: { json: { available: false, models: [] } } }),
  );

  await page.goto("/app");
  const settings = await openUserSettings(page, "boards");
  const reviewer = settings.locator("#learning-reviewer");
  await expect(reviewer).toHaveValue(JSON.stringify(["openai", "model-a", "cred"]));

  await reviewer.selectOption(JSON.stringify(["openai", "model-b", "cred"]));
  await expect(reviewer).toHaveValue(JSON.stringify(["openai", "model-b", "cred"]));

  await page.reload();
  const reloaded = await openUserSettings(page, "boards");
  await expect(reloaded.locator("#learning-reviewer")).toHaveValue(
    JSON.stringify(["openai", "model-b", "cred"]),
  );
  await captureScreenshot(page, testInfo, "boards-settings-reviewer");
});
