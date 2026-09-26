import type { IntegrationConnection, McpServer } from "@ardurbot/contracts";
import type { Locator } from "@playwright/test";
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
  await expect(settings.locator("tbody tr")).toHaveCount(10);
  await settings.getByRole("searchbox", { name: "Search integrations" }).fill("Notion");
  await expect(settings.locator("tbody tr")).toHaveCount(1);
  await expect(settings.getByTestId("integration-notion")).toBeVisible();
  await settings.getByRole("searchbox", { name: "Search integrations" }).fill("");
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

test("Find apps connects a token app, waits for an OAuth app, and manages custom rows", async ({
  page,
}, testInfo) => {
  await signup(page, `find-apps-${Date.now()}@ardurbot.test`, "password12", "Find apps test");
  await completeOnboarding(page);
  const origin = new URL(page.url()).origin;

  let remoteServers: McpServer[] = [
    customServer({ id: "unchecked-server", name: "Unchecked Server" }),
    customServer({
      id: "reconnect-server",
      name: "Needs Reconnect Server",
      oauthStatus: "reconnect",
      connectionState: "needs-sign-in",
      hasSecret: true,
      lastError: "Needs sign-in (refresh_unavailable).",
    }),
  ];
  await page.route("**/rpc/mcp/servers/list", (route) =>
    route.fulfill({ json: { json: remoteServers } }),
  );
  await page.route("**/rpc/integrations/list", (route) =>
    route.fulfill({ json: { json: { catalog: integrationCatalog, connections: [] } } }),
  );
  await page.route("**/rpc/capabilities/catalogSearch", (route) =>
    route.fulfill({
      json: {
        json: {
          enabled: true,
          results: [
            {
              domain: "github.example.test",
              name: "GitHub directory listing",
              description: "",
              pageUrl: null,
              surfaces: [
                {
                  kind: "mcp",
                  slug: "github",
                  source: "https://api.githubcopilot.com/mcp/",
                  auth: null,
                },
              ],
            },
            {
              domain: "notion.example.test",
              name: "Notion directory listing",
              description: "",
              pageUrl: null,
              surfaces: [
                { kind: "mcp", slug: "notion", source: "https://mcp.notion.com/mcp", auth: null },
              ],
            },
          ],
        },
      },
    }),
  );
  const notionConnection: IntegrationConnection = {
    id: "notion-connection",
    catalogId: "notion",
    state: "awaiting-consent",
    needsReview: false,
    spaceToolPolicies: {},
    manifest: null,
  };
  await page.route("**/rpc/integrations/connect", async (route) => {
    const input = route.request().postDataJSON().json as { catalogId: string; token?: string };
    if (input.catalogId === "github") {
      expect(input.token).toBe("fake-github-pat");
      await route.fulfill({
        json: {
          json: {
            connection: {
              id: "github-connection",
              catalogId: "github",
              state: "connected",
              needsReview: false,
              spaceToolPolicies: {},
              manifest: {
                capturedAt: "2026-09-25T00:00:00.000Z",
                serverVersion: null,
                account: null,
                workspace: null,
                scopes: [],
                tools: [],
              },
            },
            authorizationUrl: null,
            sessionId: null,
          },
        },
      });
      return;
    }
    await route.fulfill({
      json: {
        json: {
          connection: notionConnection,
          authorizationUrl: `${origin}/api/oauth/notion-pending`,
          sessionId: "notion-session",
        },
      },
    });
  });
  let cancelled = false;
  // Cancel is a real state transition, not just a dismissed wait: the mocked status
  // must reflect it so the wait's own poll is what ends it, the way the API does.
  await page.route("**/rpc/integrations/status", (route) =>
    route.fulfill({
      json: {
        json: cancelled
          ? { ...notionConnection, state: "cancelled", lastError: "Sign-in was cancelled." }
          : notionConnection,
      },
    }),
  );
  await page.route("**/rpc/integrations/cancel", (route) => {
    cancelled = true;
    return route.fulfill({ json: { json: { ok: true } } });
  });
  // The popup navigates here and stays, exactly like a person who has not
  // finished signing in yet: the app never calls integrations.status "connected".
  await page.context().route("**/api/oauth/notion-pending*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<p>Sign in to Notion to continue.</p>",
    }),
  );

  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  const settings = page.getByTestId("user-settings");
  await expect(settings).toHaveAttribute("data-settings-section", "integrations");
  await settings.getByRole("button", { name: "Find apps", exact: true }).click();
  const finder = settings.getByTestId("find-apps");
  await finder.getByRole("textbox", { name: "Search apps", exact: true }).fill("directory");
  await finder.getByRole("button", { name: "Search integrations.sh", exact: true }).click();
  await expect(finder.getByText("GitHub", { exact: true })).toBeVisible();
  await expect(finder.getByText("Notion", { exact: true })).toBeVisible();

  // A catalog-aware result whose app needs a token shows a credential field for it.
  const github = resultRow(finder, "GitHub");
  await github.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(github.getByLabel("Credential", { exact: true })).toBeVisible();
  await github.getByLabel("Credential", { exact: true }).fill("fake-github-pat");
  await captureScreenshot(page, testInfo, "find-apps-credential-field");
  await github.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(github.getByRole("button", { name: "Connected", exact: true })).toBeVisible();

  // A pure sign-in app waits for the popup and can be cancelled from this page.
  const notion = resultRow(finder, "Notion");
  await notion.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(finder.getByText("Waiting for sign-in in the other window.")).toBeVisible();
  const cancelButton = finder.getByRole("button", { name: "Cancel sign-in", exact: true });
  await expect(cancelButton).toBeVisible();
  await captureScreenshot(page, testInfo, "find-apps-waiting-for-sign-in");
  await cancelButton.click();
  await expect.poll(() => cancelled).toBe(true);
  await expect(finder.getByText("Waiting for sign-in in the other window.")).toBeHidden();

  // A custom server row offers Check, Reconnect, Manage and Delete for its state.
  await settings.getByRole("tab", { name: "Yours", exact: true }).click();
  const uncheckedRow = settings.locator("tbody tr").filter({ hasText: "Unchecked Server" });
  await expect(uncheckedRow.getByText("Not checked yet", { exact: true })).toBeVisible();
  await page.route("**/rpc/mcp/servers/tools", (route) => {
    remoteServers = remoteServers.map((server) =>
      server.id === "unchecked-server" ? { ...server, connectionState: "connected" } : server,
    );
    return route.fulfill({
      json: {
        json: {
          capturedAt: "2026-09-25T00:00:00.000Z",
          serverVersion: null,
          account: null,
          tools: [],
        },
      },
    });
  });
  await uncheckedRow.getByRole("button", { name: "Check", exact: true }).click();
  await expect(uncheckedRow.getByText("Connected", { exact: true })).toBeVisible();

  const reconnectRow = settings.locator("tbody tr").filter({ hasText: "Needs Reconnect Server" });
  await expect(reconnectRow.getByRole("button", { name: "Reconnect", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "find-apps-custom-row-actions");
  await reconnectRow.getByRole("button", { name: "Manage", exact: true }).click();
  await expect(settings).toHaveAttribute("data-settings-section", "mcp");
  await expect(settings.getByText("Manage MCP servers", { exact: true })).toBeVisible();
  await expect(settings.getByText("Needs Reconnect Server", { exact: true })).toBeVisible();

  await settings.getByTestId("settings-nav-integrations").click();
  await settings.getByRole("tab", { name: "Yours", exact: true }).click();
  let removed = false;
  await page.route("**/rpc/mcp/servers/remove", (route) => {
    removed = true;
    remoteServers = remoteServers.filter((server) => server.id !== "unchecked-server");
    return route.fulfill({ json: { json: { ok: true } } });
  });
  await uncheckedRow.getByRole("button", { name: "Delete", exact: true }).click();
  await uncheckedRow.getByRole("button", { name: "Confirm delete", exact: true }).click();
  await expect.poll(() => removed).toBe(true);
  await expect(uncheckedRow).toBeHidden();
});

function customServer(overrides: Partial<McpServer> & { id: string; name: string }): McpServer {
  return {
    id: overrides.id,
    spaceId: "space",
    slug: overrides.id,
    name: overrides.name,
    description: "",
    transport: "streamable_http",
    endpoint: `https://${overrides.id}.example.test/mcp`,
    command: null,
    args: [],
    envKeys: [],
    headerKeys: [],
    hasSecret: false,
    catalogId: null,
    managedBy: null,
    oauthStatus: "none",
    connectionState: "not-connected",
    lastError: null,
    enabled: true,
    revision: 1,
    createdAt: "2026-09-25T00:00:00.000Z",
    updatedAt: "2026-09-25T00:00:00.000Z",
    ...overrides,
  };
}

/** The row holding this result's name: its Connect button and Credential field are both
 * inside it. */
function resultRow(scope: Locator, name: string) {
  return scope.getByText(name, { exact: true }).locator("xpath=../..");
}
