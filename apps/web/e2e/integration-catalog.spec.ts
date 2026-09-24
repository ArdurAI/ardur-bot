import type { IntegrationConnection } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { integrationCatalog } from "../../../packages/adapters/src/integration-catalog.js";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("Settings catalog connects and grants only selected tools", async ({ page }, testInfo) => {
  await signup(page, `catalog-${Date.now()}@ardurbot.test`, "password12", "Catalog test");
  await completeOnboarding(page);
  const origin = new URL(page.url()).origin;
  let connections: IntegrationConnection[] = [];
  const connection: IntegrationConnection = {
    id: "synthetic-connection",
    catalogId: "notion",
    state: "connected",
    needsReview: false,
    spaceToolPolicies: {},
    manifest: {
      capturedAt: "2026-09-23T00:00:00.000Z",
      serverVersion: null,
      account: "test-account",
      workspace: "Test workspace",
      scopes: ["read", "write"],
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
  await page.route("**/rpc/integrations/resourceTools", (route) =>
    route.fulfill({ json: { json: [] } }),
  );
  await page.route("**/rpc/integrations/grants", (route) => route.fulfill({ json: { json: [] } }));
  await page.route("**/rpc/integrations/status", (route) =>
    route.fulfill({ json: { json: connections[0] } }),
  );
  await page.route("**/rpc/integrations/discover", (route) =>
    route.fulfill({ json: { json: connection.manifest } }),
  );
  await page.route("**/rpc/integrations/connect", async (route) => {
    connections = [{ ...connection, state: "awaiting-consent", manifest: null }];
    expect(route.request().postDataJSON().json.catalogId).toBe("notion");
    await route.fulfill({
      json: {
        json: {
          connection: { ...connection, state: "awaiting-consent", manifest: null },
          authorizationUrl: `${origin}/api/oauth/done?code=synthetic-code&state=synthetic-session`,
          sessionId: "synthetic-session",
        },
      },
    });
  });
  await page.context().route("**/api/oauth/done?*", async (route) => {
    connections = [connection];
    await route.fulfill({
      contentType: "text/html",
      body: "<p>Connected to Notion. You can close this tab and return to Ardur Bot.</p><script>window.close()</script>",
    });
  });
  let assigned:
    | { botIds: string[]; toolIds: string[]; spaceToolPolicies: Record<string, string> }
    | undefined;
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
  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "integrations");
  for (const name of [
    "GitHub",
    "GitLab",
    "Notion",
    "Linear",
    "Atlassian",
    "Jenkins",
    "Kubernetes",
    "AWS",
    "Google Cloud",
    "Azure",
  ])
    await expect(settings.getByText(name, { exact: true })).toBeVisible();
  for (const copy of ["Browse MCP servers", "Configure a plugin catalog", "Advanced tool sources"])
    await expect(page.getByText(copy, { exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("Search apps")).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Connect", exact: true })).toHaveCount(3);
  await expect(settings.getByText("Coming soon", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "settings-integration-catalog");
  await settings
    .getByTestId("integration-github")
    .getByRole("button", { name: "Use a token", exact: true })
    .click();
  await expect(settings.getByLabel("Fine-grained token")).toHaveAttribute("type", "password");
  await captureScreenshot(page, testInfo, "settings-integration-token");
  await settings
    .getByTestId("integration-github")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await settings
    .getByTestId("integration-notion")
    .getByRole("button", { name: "Connect", exact: true })
    .click();
  await expect(settings.getByTestId("integration-manage")).toBeVisible();
  const approval = settings.getByLabel("Permission for synthetic_read");
  await expect(approval).toHaveValue("block");
  await expect(settings.getByLabel("Permission for synthetic_update")).toHaveValue("block");
  await approval.selectOption("allow");
  await expect(approval).toHaveValue("allow");
  await approval.selectOption("ask");
  await expect(approval).toHaveValue("ask");
  await expect(settings.getByText("test-account", { exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Test", exact: true })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await settings
    .getByRole("group", { name: "Bots", exact: true })
    .getByRole("checkbox")
    .first()
    .check();
  await settings.getByLabel("Permission for synthetic_update").selectOption("ask");
  await settings.getByLabel("Notion page URL or ID").fill("a".repeat(32));
  await settings.getByRole("button", { name: "Save", exact: true }).click();
  await expect(settings.getByText("Your bots can use the selected tools.")).toBeVisible();
  expect(assigned?.botIds).toHaveLength(1);
  expect(assigned?.toolIds).toEqual(["synthetic_read", "synthetic_update"]);
  expect(assigned?.spaceToolPolicies).toEqual({
    synthetic_read: "ask-first",
    synthetic_update: "ask-first",
  });
  await captureScreenshot(page, testInfo, "settings-integration-tools");
});
