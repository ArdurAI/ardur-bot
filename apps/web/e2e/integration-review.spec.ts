import { expect, test } from "@playwright/test";
import { activeBotId, captureScreenshot, completeOnboarding, signup } from "./helpers";

test("Context shows pending tools and opens an explicit review with read-only defaults", async ({
  page,
}, testInfo) => {
  await signup(page, `review-${Date.now()}@example.test`, "password12", "Review fixture");
  await completeOnboarding(page);
  const botId = activeBotId(page);
  await page.route("**/rpc/integrations/available", (route) =>
    route.fulfill({
      json: { json: [{ id: "review-connection", name: "Notes", toolsNeedReview: true }] },
    }),
  );
  await page.route("**/rpc/integrations/toolReview", (route) =>
    route.fulfill({
      json: {
        json: {
          revision: 1,
          spaceAllowedTools: [],
          canApproveSpace: true,
          spaceNeedsReview: true,
          manifest: {
            capturedAt: "2026-10-02T00:00:00Z",
            account: null,
            serverVersion: null,
            tools: [
              {
                id: "read_item",
                description: "Read an item",
                inputSchemaDigest: "a".repeat(64),
                annotations: { readOnlyHint: true },
              },
              { id: "write_item", description: "Write an item", inputSchemaDigest: "b".repeat(64) },
            ],
          },
        },
      },
    }),
  );
  let saved = false;
  await page.route("**/rpc/integrations/reviewTools", async (route) => {
    expect(route.request().postDataJSON().json).toEqual({
      connectionId: "review-connection",
      botId,
      revision: 1,
      toolIds: ["read_item"],
      approveSpace: true,
    });
    saved = true;
    await route.fulfill({ json: { json: { ok: true } } });
  });
  await page.locator("main").getByRole("button", { name: "Chief", exact: true }).click();
  const context = page
    .getByTestId("bot-settings")
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: /^Context$/ }) })
    .first();
  await context.locator(":scope > summary").click();
  await expect(context).toContainText("Connected · tools need review");
  await captureScreenshot(page, testInfo, "context-integration-needs-review");
  await context.getByRole("button", { name: "Review tools", exact: true }).click();
  const review = page.getByTestId("bot-tool-review");
  await expect(review.getByRole("checkbox", { name: "read_item", exact: true })).toBeChecked();
  await expect(review.getByRole("checkbox", { name: "write_item", exact: true })).not.toBeChecked();
  await expect(review.getByRole("button", { name: "Allow selected", exact: true })).toBeDisabled();
  await review.getByText("Also allow these tools for the space", { exact: true }).click();
  await captureScreenshot(page, testInfo, "integration-tool-review");
  expect(saved).toBe(false);
  await review.getByRole("button", { name: "Allow selected", exact: true }).click();
  await expect(review).toHaveCount(0);
  expect(saved).toBe(true);
});
