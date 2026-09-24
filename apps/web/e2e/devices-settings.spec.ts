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
  await page.route("**/rpc/devices/revoke", (route) => {
    devices[0]!.revokedAt = new Date().toISOString();
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await page.addInitScript(() => {
    let enabled = false;
    window.ardurbotDesktop = {
      platform: "darwin",
      devices: {
        state: async () => ({ enabled, hints: [] }),
        setEnabled: async (value: boolean) => {
          enabled = value;
          return { enabled, hints: [] };
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
  await captureScreenshot(page, testInfo, "settings-devices-pairing");
  await settings.getByRole("button", { name: "Revoke", exact: true }).click();
  await expect(settings.getByText("Test phone · Revoked", { exact: true })).toBeVisible();
});
