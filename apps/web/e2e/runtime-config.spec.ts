import type { AppBootstrap, Bot, Group, SpaceNavigation } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, createNamedBot, rpc, signup } from "./helpers";
import { installPerformanceFixture } from "./performance-fixture";

const botConfig = {
  version: 2,
  runtimeKind: "hermes",
  limits: { maxProviderRequests: 10, timeoutMs: 60_000 },
  context: { maxInputBytes: 32_768, overflow: "trim" },
  harness: { agent: { api_max_retries: 1 } },
} as const;

const capturedConfig = {
  version: 2,
  runtimeKind: "hermes",
  limits: { maxProviderRequests: 5, timeoutMs: 30_000 },
  context: { maxInputBytes: 16_384, overflow: "trim" },
  harness: { agent: { api_max_retries: 1 } },
} as const;

test("the Hermes short panel and Advanced editor share one draft", async ({ page }, testInfo) => {
  await installPerformanceFixture(page);
  // The shared fixture answers every runtime probe with an empty list. The settings
  // form reads that result's model list, so Hermes never stays on screen.
  await page.route("**/rpc/runtimes/availability", (route) =>
    route.fulfill({
      json: {
        json: {
          runtimeKind: "hermes",
          available: false,
          reason: "Hermes is not installed on this computer.",
          models: [],
        },
      },
    }),
  );
  await page.route("**/rpc/runtimeConfig/preview", (route) =>
    route.fulfill({
      json: {
        json: {
          preview: {
            settings: {
              version: 2,
              runtimeKind: "hermes",
              limits: { maxProviderRequests: 16, timeoutMs: 180_000 },
              context: { maxInputBytes: 16_384, overflow: "trim" },
              harness: { agent: { api_max_retries: 1 } },
            },
            managed: {
              model: "fixture-model",
              thinkingLevel: "off",
              connection: "fixture-connection",
              credentials: "broker-grant",
              tools: "ardur-catalog",
              approvals: "ardur-policy",
              paths: "ephemeral-owned-home",
              nativeChildren: false,
              nativeCompression: false,
            },
          },
          issues: [],
        },
      },
    }),
  );
  await page.goto("/app/fixture-bot-0");
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByRole("combobox", { name: "Runs on" }).selectOption("hermes");

  const panel = settings.getByTestId("runtime-config-panel");
  await expect(panel.getByLabel("Model calls per turn")).toHaveValue("16");
  await expect(panel.getByLabel("Time limit (seconds)")).toHaveValue("180");
  await expect(panel.getByLabel("Context limit (KiB)")).toHaveValue("16");
  await expect(panel.getByRole("button", { name: "Learning" })).toBeVisible();

  await panel.getByText("Advanced", { exact: true }).click();
  const editor = settings.getByTestId("runtime-config-advanced");
  const json = editor.getByRole("textbox", { name: "Configuration (JSON)" });
  await expect(json).toBeVisible();
  await expect(editor.getByText("Effective configuration")).toBeVisible();
  await expect(editor.getByText("Your settings")).toBeVisible();
  await expect(editor.getByText("Ardur manages")).toBeVisible();
  await expect(editor.getByText("Unavailable with Hermes.")).toBeVisible();

  await json.fill("{ not valid json");
  await expect(editor.getByRole("alert")).toHaveText("Enter valid JSON.");
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeDisabled();

  await editor.getByRole("button", { name: "Reset to defaults" }).click();
  await expect(editor.getByRole("alert")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  await expect(json).toHaveValue(/"maxProviderRequests": 16/);
  await captureScreenshot(page, testInfo, "runtime-config-advanced");
  await page.unrouteAll({ behavior: "ignoreErrors" });
});

test("a group shows captured runtime settings and refreshes them from the bot", async ({
  page,
}, testInfo) => {
  await signup(page, `runtime-config-${Date.now()}@ardurbot.test`, "password12", "Runtime Config");
  await completeOnboarding(page);
  await page.waitForURL(/\/app\/(?!bots$)[^/]+$/);
  const botId = await createNamedBot(page, "Config bot");
  const partnerId = await createNamedBot(page, "Config partner");
  const group = await rpc<Group>(page, "groups/create", {
    name: "Config room",
    botIds: [botId, partnerId],
  });
  const memberId = group.members.find((entry) => entry.botId === botId)?.memberId;
  const partnerMemberId = group.members.find((entry) => entry.botId === partnerId)?.memberId;
  if (!memberId || !partnerMemberId) throw new Error("group is missing a member");

  const hermesBot = {
    runtimeKind: "hermes",
    runtimeExperimental: true,
    modelProvider: "openai-compatible",
    modelId: "fixture-model",
    modelCredentialId: "fixture-connection",
    modelPinRevision: 3,
    runtimeConfig: botConfig,
  } satisfies Partial<Bot>;
  const hermesPin = {
    runtimeKind: "hermes",
    provider: "openai-compatible",
    modelId: "fixture-model",
    effort: null,
    credentialId: "fixture-connection",
    revision: 1,
    runtimeConfig: capturedConfig,
  };
  const patchBot = (bots: Bot[]) =>
    bots.map((bot) => (bot.id === botId ? { ...bot, ...hermesBot } : bot));
  let groupState: Group = {
    ...group,
    members: group.members.map((item) =>
      item.botId === botId ? { ...item, modelPinRevision: 1, runtimePin: hermesPin } : item,
    ),
  };
  const patchGroup = (entry: Group): Group => (entry.id === group.id ? groupState : entry);
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: AppBootstrap };
    body.json.bots = patchBot(body.json.bots);
    body.json.groups = body.json.groups.map(patchGroup);
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/spaces/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: SpaceNavigation };
    body.json.current.bots = patchBot(body.json.current.bots);
    body.json.current.groups = body.json.current.groups.map(patchGroup);
    await route.fulfill({ response, json: body });
  });
  await page.route("**/rpc/groups/list", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { json: Group[] };
    await route.fulfill({ response, json: { json: body.json.map(patchGroup) } });
  });

  await page.goto(`/app/g/${group.id}`);
  await page.getByTestId("bot-settings-trigger").click();
  const control = page.getByTestId(`group-model-${botId}`);
  await control.getByText("Runtime settings", { exact: true }).click();
  await expect(control.getByText("Model calls per turn: 5")).toBeVisible();
  await expect(control.getByText("Time limit (seconds): 30")).toBeVisible();
  await expect(control.getByText("Context limit (KiB): 16")).toBeVisible();
  await expect(control.getByText("Captured for this group.")).toBeVisible();
  await captureScreenshot(page, testInfo, "runtime-config-group-captured");

  await page.route("**/rpc/groups/setMemberModelPin", async (route) => {
    groupState = {
      ...group,
      members: group.members.map((item) =>
        item.botId === botId
          ? {
              ...item,
              modelPinRevision: 3,
              runtimePin: {
                ...hermesPin,
                revision: 3,
                runtimeConfig: botConfig,
              },
            }
          : item,
      ),
    };
    await route.fulfill({
      status: 200,
      json: { json: groupState },
    });
  });

  const refresh = page.waitForRequest(
    (request) =>
      request.url().includes("/rpc/groups/setMemberModelPin") && request.method() === "POST",
  );
  const responded = page.waitForResponse(
    (response) =>
      response.url().includes("/rpc/groups/setMemberModelPin") &&
      response.request().method() === "POST",
  );
  await control.getByRole("button", { name: "Use bot runtime settings" }).click();
  const request = await refresh;
  const response = await responded;
  expect(response.ok()).toBe(true);
  expect(response.status()).toBe(200);
  const sent = request.postDataJSON() as {
    json: {
      botId: string;
      memberId: string;
      expectedRevision: number;
      expectedBotModelPinRevision?: number;
      pin: { runtimeKind: string; provider: string; modelId: string };
    };
  };
  expect(sent.json.botId).toBe(botId);
  expect(sent.json.memberId).toBe(memberId);
  expect(sent.json.expectedRevision).toBe(1);
  expect(sent.json.expectedBotModelPinRevision).toBe(3);
  expect(sent.json.pin).toMatchObject({
    runtimeKind: "hermes",
    provider: "openai-compatible",
    modelId: "fixture-model",
  });
  await expect(control.getByText("Model calls per turn: 10")).toBeVisible();
  await expect(control.getByText("Time limit (seconds): 60")).toBeVisible();
  await expect(control.getByText("Context limit (KiB): 32")).toBeVisible();
  await expect(control.getByRole("button", { name: "Use bot runtime settings" })).toHaveCount(0);
  await page.unrouteAll({ behavior: "ignoreErrors" });
});
