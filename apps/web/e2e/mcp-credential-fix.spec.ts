import type { McpServer } from "@ardurbot/contracts";
import { mcpSignInDiagnostic } from "@ardurbot/contracts";
import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

async function openMcpSettings(page: Page) {
  await page.getByText("Integrations", { exact: true }).click();
  await page.getByTestId("settings-nav-mcp").click();
  await expect(page.getByRole("heading", { name: "MCP", exact: true })).toBeVisible();
}

test("shows Update credential for a server whose saved token was rejected", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `mcp-credential-fix-${stamp}@ardurbot.test`, "password12", "Credential Fix");
  await completeOnboarding(page);

  const server: McpServer = {
    id: "reports-server",
    spaceId: "credential-fix-workspace",
    slug: "reports",
    name: "Reports MCP",
    description: "",
    transport: "streamable_http",
    endpoint: "https://reports.example.test/mcp",
    command: null,
    args: [],
    envKeys: [],
    headerKeys: [],
    hasSecret: true,
    oauthStatus: "none",
    connectionState: "needs-sign-in",
    lastError: mcpSignInDiagnostic("credential_rejected"),
    enabled: true,
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [server] }),
    });
  });
  await page.context().route("**/rpc/mcp/assignments/all", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [] }) });
  });

  await openMcpSettings(page);
  await expect(page.getByText("Reports MCP", { exact: true })).toBeVisible();
  const updateButton = page.getByRole("button", { name: "Update credential", exact: true });
  await expect(updateButton).toBeVisible();
  await updateButton.click();
  await expect(page.getByLabel("New access token", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-update-credential");
});

test("shows Keep token and Keep header for a server with two saved credentials", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(
    page,
    `mcp-credential-conflict-${stamp}@ardurbot.test`,
    "password12",
    "Credential Conflict",
  );
  await completeOnboarding(page);

  const server: McpServer & { credentialConflict?: boolean } = {
    id: "reports-server",
    spaceId: "credential-conflict-workspace",
    slug: "reports",
    name: "Reports MCP",
    description: "",
    transport: "streamable_http",
    endpoint: "https://reports.example.test/mcp",
    command: null,
    args: [],
    envKeys: [],
    headerKeys: ["Authorization"],
    hasSecret: true,
    credentialConflict: true,
    oauthStatus: "none",
    connectionState: "connected",
    lastError: null,
    enabled: true,
    revision: 1,
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
  };
  await page.context().route("**/rpc/mcp/servers/list", async (route) => {
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ json: [server] }),
    });
  });
  await page.context().route("**/rpc/mcp/assignments/all", async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json: [] }) });
  });

  await openMcpSettings(page);
  await expect(page.getByText("This server has two credentials. Keep one.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep token", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Keep header", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "mcp-two-credentials");
});
