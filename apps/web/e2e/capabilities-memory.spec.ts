import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("capabilities and memory use persisted settings, confirmation, and proposals", async ({
  page,
}, testInfo) => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  let settings = {
    toolAccessMode: "when-needed",
    connectorSearch: false,
    inlineVisualizations: true,
  };
  const documents = [
    { id: "profile", kind: "profile", content: "Studies plants.", path: "learned/profile.md" },
    {
      id: "preferences",
      kind: "preferences",
      content: "Use concise answers.",
      path: "learned/preferences.md",
    },
    {
      id: "garden",
      kind: "topic",
      content: "# Garden planning\nSeasonal planting notes.",
      path: "learned/garden.md",
    },
  ].map((document) => ({
    ...document,
    revision: 1,
    scopeKey: { kind: "user", spaceId: "space", userId: "user" },
    author: { kind: "user", userId: "user" },
    model: null,
    runId: null,
    threadId: null,
    references: [],
    createdAt: "2026-09-24T12:00:00.000Z",
    updatedAt: "2026-09-24T12:00:00.000Z",
    deletedAt: null,
    delivery: { status: "delivered", generation: 0, provider: null },
  }));
  await page.route("**/rpc/**", async (route) => {
    const path = new URL(route.request().url()).pathname.slice(5);
    const body = (route.request().postDataJSON()?.json ?? {}) as Record<string, unknown>;
    calls.push({ path, body });
    let result: unknown = {};
    if (path === "capabilities/settings")
      result = {
        settings,
        canConfigure: true,
        unsupportedRuntimes: [],
        computers: [
          {
            id: "computer",
            name: "Computer",
            kind: "docker",
            networkEgress: true,
            supported: true,
            pending: false,
          },
        ],
      };
    if (path === "capabilities/configure") result = settings = { ...settings, ...body };
    if (path === "capabilities/network") result = { id: "update", status: "queued" };
    if (path === "learning/summary") result = { pendingCount: 0, appliedThisWeek: 0 };
    if (path === "learning/list")
      result = { reviews: [], proposals: [], pendingCount: 0, appliedThisWeek: 0 };
    if (path === "learning/settings")
      result = {
        enabled: false,
        consolidationEnabled: false,
        reviewerPin: null,
        canConfigure: true,
        destination: {
          runtimeKind: "pi",
          provider: "openai-compatible",
          modelId: "fixture",
          credentialId: "fixture",
          effort: "medium",
          revision: 0,
        },
        budgets: {
          botDailyTokens: 30000,
          spaceDailyTokens: 150000,
          maxProposals: 3,
          timeoutMs: 30000,
          maxOutputTokens: 2000,
          maxOutputChars: 12000,
        },
      };
    if (path === "memory/list") result = { items: documents, nextCursor: null };
    if (path === "memory/propose")
      result = [
        {
          id: "proposal",
          type: "memory",
          scope: { spaceId: "space", userId: "user" },
          target: {},
          proposedContent: "Use concise answers.",
          rationale: "Requested memory change.",
          evidenceIds: ["evidence"],
          diff: "--- current\n+++ proposed\n+Use concise answers.",
          status: "pending",
          operation: body.intent === "import" ? "memory-import" : "memory-edit",
          expiresAt: "2099-01-01T00:00:00Z",
        },
      ];
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/src/pages/capabilities/__fixtures__/settings.html");
  await expect(page.getByTestId("capabilities-settings")).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Allow network egress for Computer" }),
  ).toBeVisible();
  await expect(
    page.getByRole("switch", { name: "Connector search", exact: true }),
  ).not.toBeChecked();
  await page.getByRole("switch", { name: "Connector search", exact: true }).click();
  await expect(page.getByRole("switch", { name: "Connector search", exact: true })).toBeChecked();
  await page.getByRole("switch", { name: "Allow network egress for Computer" }).click();
  await expect(page.getByRole("alertdialog")).toBeVisible();
  expect(calls.some((call) => call.path === "capabilities/network")).toBe(false);
  await page.getByRole("button", { name: "Continue", exact: true }).click();
  await expect
    .poll(() => calls.filter((call) => call.path === "capabilities/network"))
    .toHaveLength(1);
  await captureScreenshot(page, testInfo, "capabilities");
  await page.getByTestId("settings-nav-memory").click();
  await expect(page.getByTestId("memory-settings-page")).toBeVisible();
  await expect(page.getByRole("button", { name: /Preferences.*Updated/ })).toBeVisible();
  await captureScreenshot(page, testInfo, "memory-documents");
  await page.getByRole("button", { name: "Start import" }).click();
  await page.getByLabel("Paste the response").fill("Preferences\n- Use concise answers.");
  await page.getByRole("button", { name: "Review import", exact: true }).click();
  await expect(page.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
  expect(
    calls.some((call) =>
      ["learning/approve", "memory/update", "memory/import"].includes(call.path),
    ),
  ).toBe(false);
  await captureScreenshot(page, testInfo, "memory-pending-import");
  await page.getByLabel("Tell your bot what to change or remove").fill("Use concise answers.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => calls.filter((call) => call.path === "memory/propose")).toHaveLength(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-testid="user-settings"] .rk-scroll').evaluate((panel) => {
    panel.scrollTop = 0;
  });
  await captureScreenshot(page, testInfo, "memory-narrow");
});
