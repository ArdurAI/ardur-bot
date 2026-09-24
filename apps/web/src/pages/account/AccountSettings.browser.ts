import { expect, test } from "@playwright/test";
import { accountFixture, localDevicesFixture, sessionsFixture } from "./account-fixtures";

test("Account profile, trust, sessions, and desktop badge work with offline fixtures", async ({
  page,
}, testInfo) => {
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
    console.error(error.message);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      pageErrors.push(message.text());
      console.error(message.text());
    }
  });
  let profile = { ...accountFixture };
  let devices = structuredClone(localDevicesFixture);
  let sessions = structuredClone(sessionsFixture);
  await page.route("**/api/auth/**", (route) => route.fulfill({ json: null }));
  await page.route("**/rpc/account/**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    const input = route.request().postDataJSON()?.json;
    let result: unknown;
    if (action === "get") result = profile;
    else if (action === "localDevices") result = devices;
    else if (action === "sessions") result = sessions;
    else if (action === "updateProfile") {
      profile = { ...profile, ...input };
      result = input;
    } else if (action === "updateInstructions") {
      profile = {
        ...profile,
        instructions: input.instructions,
        instructionsRevision: input.revision + 1,
      };
      result = { revision: profile.instructionsRevision };
    } else if (action === "setTrustedDevices") {
      profile.requireTrustedDevices = input.required;
      result = { required: input.required };
    } else if (action === "approveDevice") {
      devices = devices.map((device) =>
        device.id === input.id ? { ...device, approved: true } : device,
      );
      result = { ok: true };
    } else if (action === "disconnectDevice") {
      devices = devices.filter((device) => device.id !== input.id || device.kind !== input.kind);
      result = { ok: true };
    } else if (action === "revokeSession") {
      sessions = sessions.filter((session) => session.id !== input.id);
      result = { ok: true };
    } else if (action === "revokeOtherSessions") {
      sessions = sessions.filter((session) => session.current);
      result = { ok: true };
    } else throw new Error(`Unexpected account action: ${action}`);
    await route.fulfill({ json: { json: result } });
  });
  await page.addInitScript(() => {
    window.ardurbotDesktop = {
      platform: "linux",
      host: {
        state: async () => ({ configured: true, roots: [], registrationId: "host-generation" }),
        clear: async () => undefined,
      },
    } as unknown as NonNullable<Window["ardurbotDesktop"]>;
  });
  await page.route("**/account-verification", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: '<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="root"></div><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true; await import("/src/pages/account/account-preview.tsx");</script></body></html>',
    }),
  );
  await page.goto("/account-verification");
  await expect(page.getByLabel("Full name", { exact: true })).toHaveValue("Test operator", {
    timeout: 30000,
  });
  await page.getByLabel("What should your bots call you?").fill("Chief");
  await page.getByRole("button", { name: "Save", exact: true }).first().click();
  await expect(page.getByText("Saved", { exact: true })).toBeVisible();
  expect(profile.displayName).toBe("Chief");
  await expect(page.getByText("This computer", { exact: true })).toBeVisible();
  await page.getByRole("switch", { name: "Require trusted devices" }).click();
  await expect(page.getByRole("switch", { name: "Require trusted devices" })).toBeChecked();
  await page.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByText("Needs approval")).toHaveCount(0);
  await expect(page.getByText("Showing 1–10 of 14")).toBeVisible();
  await page.getByRole("button", { name: "Next", exact: true }).click();
  await expect(page.getByText("Showing 11–14 of 14")).toBeVisible();
  await page.getByRole("button", { name: "Session actions", exact: true }).first().click();
  await page.getByRole("menuitem", { name: "Sign out", exact: true }).click();
  await expect(page.getByText("Showing 11–13 of 13")).toBeVisible();
  await page.getByRole("button", { name: "Previous", exact: true }).click();
  await page.screenshot({ path: testInfo.outputPath("account-settings.png"), fullPage: true });
  await testInfo.attach("Account settings", {
    path: testInfo.outputPath("account-settings.png"),
    contentType: "image/png",
  });
  await page.getByRole("button", { name: "Log out", exact: true }).click();
  const confirmation = page.getByRole("alertdialog");
  await expect(confirmation).toContainText(
    "This signs out every other session and keeps this one signed in.",
  );
  await confirmation.getByRole("button", { name: "Log out", exact: true }).click();
  await expect(page.getByText("Showing 1–1 of 1")).toBeVisible();
  await expect(page.getByText("Current", { exact: true })).toBeVisible();
  expect(pageErrors).toEqual([]);
});
