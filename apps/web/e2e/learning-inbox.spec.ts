import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

test("learning inbox separates suggestions from applied changes and shows Undo", async ({
  page,
}, testInfo) => {
  await signup(page, `learning-${Date.now()}@ardurbot.test`, "password12", "Learning fixture");
  await completeOnboarding(page);
  await page.goto("/app");
  let status = "pending";
  const proposal = () => ({
    id: "proposal",
    type: "memory",
    scope: { spaceId: "space", userId: "user", botId: "bot" },
    target: {},
    expectedBaseRevision: 0,
    proposedContent: "Use numbered steps for repeatable procedures.",
    rationale: "The owner requested this format.",
    evidenceIds: ["evidence"],
    confidence: { label: "model estimate", value: 0.8 },
    diff: "--- current\n+++ proposed\n-\n+Use numbered steps for repeatable procedures.",
    status,
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await page.route("**/rpc/learning/**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "approve") status = "applied";
    if (action === "revert") status = "reverted";
    const json =
      action === "list" || action === "summary"
        ? {
            reviews: [],
            proposals: [proposal()],
            pendingCount: status === "pending" ? 3 : 0,
            appliedThisWeek: status === "applied" ? 1 : 0,
          }
        : action === "settings"
          ? {
              enabled: true,
              canConfigure: false,
              reviewerPin: null,
              destination: null,
              budgets: {},
            }
          : action === "grants"
            ? { grants: [], offers: [] }
            : { proposal: proposal() };
    await route.fulfill({ contentType: "application/json", body: JSON.stringify({ json }) });
  });
  await openUserSettings(page, "memory");
  await page.getByRole("tab", { name: /Learning/ }).click();
  const inbox = page.getByTestId("learning-inbox");
  await expect(inbox.getByText("3 suggestions to review", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "learning-inbox-pending");
  await inbox.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(inbox.getByText("Applied", { exact: true })).toBeVisible();
  await inbox.getByText("Details", { exact: true }).click();
  await expect(inbox.getByText("no observations yet", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "learning-inbox-applied");
  await inbox.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(inbox.getByText("Undone", { exact: true })).toBeVisible();
});
