import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("devices shows pairing, listener state and revocable grants", async ({ page }, testInfo) => {
  await page.route("**/rpc/bootstrap", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: { json: { ...body.json, me: { ...body.json.me, isDeploymentOwner: true } } },
    });
  });
  const fingerprint = "a".repeat(64);
  const certificateFingerprint = "b".repeat(64);
  const devices = [
    {
      id: "test-phone",
      deviceName: "Test phone",
      scopes: ["read", "dispatch", "approve"],
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      lastPresenceAt: null,
      revokedAt: null as string | null,
      defaultBotId: null,
    },
  ];
  await page.route("**/rpc/devices/list", (route) =>
    route.fulfill({
      json: {
        json: { instanceId: "test-home", homeName: "Test home", fingerprint, devices, pending: [] },
      },
    }),
  );
  await page.route("**/rpc/pairing/start", (route) =>
    route.fulfill({
      json: {
        json: {
          payload: {
            version: 1,
            challenge: "nonredeemable-screenshot-challenge",
            instanceId: "test-home",
            homeName: "Test home",
            fingerprint,
            certificateFingerprint,
            hints: ["https://home.example.test"],
          },
          shortCode: "TESTCODE",
          expiresAt: new Date(Date.now() + 300_000).toISOString(),
        },
      },
    }),
  );
  await page.route("**/rpc/channelPairing/installations", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            id: "chat-installation",
            provider: "telegram",
            workspaceId: "telegram",
            botId: "test-bot",
          },
        ],
      },
    }),
  );
  await page.route("**/rpc/channelPairing/start", (route) =>
    route.fulfill({
      json: {
        json: { code: "PAIRTEST1234", expiresAt: new Date(Date.now() + 300_000).toISOString() },
      },
    }),
  );
  await page.route("**/rpc/devices/revoke", (route) => {
    devices[0]!.revokedAt = new Date().toISOString();
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.addInitScript(() => {
    let enabled = false;
    window.ardurbotDesktop = {
      platform: "darwin",
      devices: {
        state: async () => ({ enabled, hints: [], available: true, mode: "new" }),
        setEnabled: async (value: boolean) => {
          enabled = value;
          return { enabled, hints: [], available: true, mode: "new" };
        },
      },
    } as typeof window.ardurbotDesktop;
  });
  await signup(page, `devices-${Date.now()}@example.test`, "password12", "Device test");
  await completeOnboarding(page);
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-devices").click();
  await expect(settings.getByText("Test phone", { exact: true })).toBeVisible();
  await expect(
    settings.getByLabel("Your phone can reach this Mac on your network."),
  ).not.toBeChecked();
  await settings.getByRole("button", { name: "Pair device", exact: true }).click();
  await expect(settings.getByRole("img", { name: "Pair device" })).toBeVisible();
  await expect(settings.getByText("TESTCODE", { exact: true })).toBeVisible();
  await settings.getByRole("button", { name: "Pair a chat account", exact: true }).click();
  await settings.getByRole("button", { name: "Get pairing code", exact: true }).click();
  await expect(settings.getByText("PAIRTEST1234", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "settings-devices-pairing");
  await settings.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(settings.getByText("Test phone · Revoked", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    window.ardurbotDesktop!.devices!.state = async () => ({
      enabled: false,
      hints: [],
      available: false,
      mode: "existing",
    });
  });
  await settings.getByTestId("settings-nav-general").click();
  await settings.getByTestId("settings-nav-devices").click();
  await expect(
    settings.getByText(
      "Phone pairing needs a home run by this app. Set up This computer to use it.",
    ),
  ).toBeVisible();
  await expect(settings.getByLabel("Your phone can reach this Mac on your network.")).toHaveCount(
    0,
  );
  await captureScreenshot(page, testInfo, "settings-devices-existing-instance");
});

test("activity opens a shared-room task without the personal bot transcript", async ({
  page,
}, testInfo) => {
  await signup(page, `room-review-${Date.now()}@example.test`, "password12", "Room test");
  await completeOnboarding(page);
  const run = {
    runId: "room-run",
    botId: "room-bot",
    botName: "Room bot",
    groupId: null,
    groupName: null,
    threadId: "room-thread",
    externalThread: true,
    status: "waiting_input",
    trigger: "user",
    notificationsEnabled: false,
    promptSnippet: "Review the public example",
    updatedAt: new Date().toISOString(),
  };
  await page.route("**/rpc/runs/list", (route) =>
    route.fulfill({ json: { json: { runs: [run] } } }),
  );
  await page.route("**/rpc/threads/get", async (route) => {
    if (!route.request().postData()?.includes("room-thread")) return route.continue();
    return route.fulfill({
      json: {
        json: {
          botId: "room-bot",
          threadId: "room-thread",
          cursor: 1,
          olderCursor: null,
          run: { id: "room-run", taskId: "room-task", status: "waiting_input" },
          messages: [
            {
              id: "room-message",
              role: "bot",
              runId: "room-run",
              seq: 1,
              blocks: [
                {
                  kind: "ask",
                  text: "Read the public example?",
                  detail: "read_file: example.txt",
                  approvalEffectId: "room-effect",
                  status: "pending",
                  actions: [
                    { id: "allow", label: "Read" },
                    { id: "deny", label: "Cancel" },
                  ],
                },
              ],
            },
          ],
        },
      },
    });
  });
  await page.getByRole("button", { name: "Activity", exact: true }).click();
  await page.getByRole("button", { name: "Room bot, Needs input", exact: true }).first().click();
  await expect(page.getByTestId("chat-task-review")).toBeVisible();
  await expect(page.getByText("Read the public example?", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "dispatch-room-review");
});
