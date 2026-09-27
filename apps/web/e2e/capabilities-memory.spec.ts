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
  const importedContent = "- Keep ~/repos/ reports and code.\n  - Use plain prose.";
  const fakeToken = "abcdefghijklmnopqrstuvwxyz123456";
  const blockedLine = `- Key: ${fakeToken}`;
  const paste = `Preferences\n${importedContent}\n\nTopic: Access\n${blockedLine}`;
  const correctedPaste = `Preferences\n${importedContent}`;
  const safeProposal = {
    id: "proposal",
    type: "memory",
    scope: { spaceId: "space", userId: "user" },
    target: {},
    documentKind: "preferences",
    proposedContent: importedContent,
    rationale: "Requested memory change.",
    evidenceIds: ["evidence"],
    diff: `--- current\n+++ proposed\n+${importedContent}`,
    status: "pending",
    operation: "memory-import",
    expiresAt: "2099-01-01T00:00:00Z",
  };
  let importProposed = false;
  let approved = false;
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
      result = {
        reviews: [],
        proposals: importProposed && !approved ? [safeProposal] : [],
        pendingCount: importProposed && !approved ? 1 : 0,
        appliedThisWeek: approved ? 1 : 0,
      };
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
    if (path === "memory/list")
      result = {
        items: documents.map((document) =>
          approved && document.id === "preferences"
            ? { ...document, content: importedContent, revision: 2 }
            : document,
        ),
        nextCursor: null,
      };
    if (path === "memory/history") {
      const document = documents.find((item) => item.id === body.documentId);
      result = {
        items: document
          ? [
              {
                kind: document.kind,
                documentId: document.id,
                revision: approved && document.id === "preferences" ? 2 : 1,
                scopeKey: document.scopeKey,
                path: document.path,
                content:
                  approved && document.id === "preferences" ? importedContent : document.content,
                author: document.author,
                model: document.model,
                runId: document.runId,
                threadId: document.threadId,
                references: document.references,
                createdAt: document.createdAt,
                deletedAt: document.deletedAt,
              },
            ]
          : [],
        nextCursor: null,
      };
    }
    if (path === "memory/propose") {
      if (body.intent === "import" && String(body.text).includes(fakeToken)) {
        await route.fulfill({
          status: 400,
          json: {
            json: {
              defined: false,
              code: "BAD_REQUEST",
              status: 400,
              message: "Remove credentials from this memory before saving.",
              data: {
                code: "MEMORY_CREDENTIAL_LINE",
                lineNumber: 6,
                maskedLine: "- Key: [redacted]",
              },
            },
          },
        });
        return;
      }
      if (body.intent === "import") importProposed = true;
      result =
        body.intent === "import"
          ? [safeProposal]
          : [
              {
                ...safeProposal,
                id: "edit-proposal",
                proposedContent: "Use concise answers.",
                operation: "memory-edit",
              },
            ];
    }
    if (path === "learning/approve") {
      approved = true;
      result = { proposal: { ...safeProposal, status: "applied" } };
    }
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
  await page.getByLabel("Paste the response").fill(paste);
  await page.getByRole("button", { name: "Review import", exact: true }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "Line 6: - Key: [redacted] Edit or remove this line.",
  );
  await expect(page.getByRole("alert")).not.toContainText(fakeToken);
  await expect(page.getByLabel("Paste the response")).toHaveValue(paste);
  const suggestions = page.getByRole("region", { name: "Memory suggestions" });
  await expect(suggestions).toHaveCount(0);
  await page.getByLabel("Paste the response").fill(correctedPaste);
  await page.getByRole("button", { name: "Review import", exact: true }).click();
  const safeCard = suggestions.locator("article").filter({ hasText: importedContent });
  await expect(safeCard.getByRole("button", { name: "Approve" })).toBeVisible();
  expect(calls.find((call) => call.path === "memory/propose")?.body.text).toBe(paste);
  expect(
    calls.some((call) =>
      ["learning/approve", "memory/update", "memory/import"].includes(call.path),
    ),
  ).toBe(false);
  await captureScreenshot(page, testInfo, "memory-pending-import");
  await safeCard.getByRole("button", { name: "Approve" }).click();
  await expect(safeCard).toHaveCount(0);
  expect(
    calls.filter((call) => call.path === "learning/approve").map((call) => call.body.proposalId),
  ).toEqual([safeProposal.id]);
  await page.getByRole("button", { name: /Preferences.*Updated/ }).click();
  const documentContent = page
    .getByRole("region", { name: "Memory document" })
    .locator("p.whitespace-pre-wrap");
  await expect.poll(() => documentContent.textContent()).toBe(importedContent);
  await expect
    .poll(() =>
      calls.filter((call) => call.path === "memory/history").map((call) => call.body.documentId),
    )
    .toContain("preferences");
  await page.getByLabel("Tell your bot what to change or remove").fill("Use concise answers.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => calls.filter((call) => call.path === "memory/propose")).toHaveLength(3);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('[data-testid="user-settings"] .rk-scroll').evaluate((panel) => {
    panel.scrollTop = 0;
  });
  await captureScreenshot(page, testInfo, "memory-narrow");
});
