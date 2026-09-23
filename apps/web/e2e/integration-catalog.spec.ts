import type { IntegrationConnection } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { integrationCatalog } from "../../../packages/adapters/src/integration-catalog.js";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("Settings catalog connects and grants only selected tools", async ({ page }, testInfo) => {
  await signup(page, `catalog-${Date.now()}@ardurbot.test`, "password12", "Catalog test");
  await completeOnboarding(page);
  const origin = new URL(page.url()).origin;
  let connections: IntegrationConnection[] = [];
  const connection: IntegrationConnection = {
    id: "synthetic-connection",
    catalogId: "github",
    state: "connected",
    needsReview: false,
    manifest: {
      capturedAt: "2026-09-23T00:00:00.000Z",
      serverVersion: null,
      account: null,
      tools: [
        {
          id: "synthetic_read",
          description: "Synthetic fixture, not a vendor tool",
          inputSchemaDigest: "a".repeat(64),
        },
        {
          id: "synthetic_update",
          description: "Synthetic write fixture",
          inputSchemaDigest: "b".repeat(64),
        },
      ],
    },
  };
  await page.route("**/rpc/integrations/list", (route) =>
    route.fulfill({ json: { json: { catalog: integrationCatalog, connections } } }),
  );
  await page.route("**/rpc/integrations/grants", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/integrations/connect", async (route) => {
    expect(route.request().postDataJSON().json.catalogId).toBe("github");
    await route.fulfill({
      json: {
        json: {
          connection: { ...connection, state: "awaiting-consent", manifest: null },
          authorizationUrl: `${origin}/mcp/oauth/callback?code=synthetic-code&state=synthetic-session`,
          sessionId: "synthetic-session",
        },
      },
    });
  });
  await page.context().route("**/rpc/mcp/oauth/complete", async (route) => {
    connections = [connection];
    await route.fulfill({ json: { json: { ok: true } } });
  });
  let assigned: { botIds: string[]; toolIds: string[] } | undefined;
  await page.route("**/rpc/integrations/assign", async (route) => {
    assigned = route.request().postDataJSON().json;
    await route.fulfill({
      json: {
        json: assigned!.botIds.map((botId) => ({
          botId,
          toolIds: assigned!.toolIds,
          needsReview: false,
        })),
      },
    });
  });
  const settings = await openUserSettings(page);
  await settings.getByTestId("settings-nav-integrations").click();
  await expect(settings.getByRole("button", { name: "Connect", exact: true })).toHaveCount(3);
  await expect(settings.getByText("Coming soon", { exact: true })).toHaveCount(5);
  await captureScreenshot(page, testInfo, "settings-integration-catalog");
  await settings
    .getByTestId("integration-github")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect(settings.getByTestId("integration-manage")).toBeVisible();
  await expect(
    settings.getByRole("checkbox", { name: "synthetic_read", exact: true }),
  ).not.toBeChecked();
  await expect(
    settings.getByRole("checkbox", { name: "synthetic_update", exact: true }),
  ).not.toBeChecked();
  await expect(settings.getByText("asks first", { exact: true })).toHaveCount(2);
  await settings
    .getByRole("group", { name: "Bots", exact: true })
    .getByRole("checkbox")
    .first()
    .check();
  await settings.getByRole("checkbox", { name: "synthetic_update", exact: true }).check();
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByText("Your bots can use the selected tools.")).toBeVisible();
  expect(assigned?.botIds).toHaveLength(1);
  expect(assigned?.toolIds).toEqual(["synthetic_update"]);
  await captureScreenshot(page, testInfo, "settings-integration-tools");
});
