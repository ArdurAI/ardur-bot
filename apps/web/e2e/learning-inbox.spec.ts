import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot, completeOnboarding, openUserSettings, signup } from "./helpers";

const observation = {
  documentId: "doc",
  revisionId: "doc:2",
  exposedRuns: 1,
  correctionsAfter: { feedback: 1, steering: 0 },
  before: {
    runs: 9,
    comparableExposedRuns: 1,
    corrections: { feedback: 3, steering: 0 },
    window: { from: "2026-09-03T00:00:00.000Z", to: "2026-09-10T00:00:00.000Z" },
  },
  denialsAfter: { inappropriate: 0, safety: 0, unknown: 0 },
  failuresAfter: { task: 0, integration: 0, provider: 0, pin: 0, unknown: 0 },
  cancellationsAfter: 0,
  acceptance: { accepted: 0, evaluated: 0, contracts: 0 },
  timeTokensDelta: {
    timeMs: { beforeSamples: 9, afterSamples: 1, beforeMean: 60000, afterMean: 60000, delta: null },
    tokens: { beforeSamples: 9, afterSamples: 1, beforeMean: 100, afterMean: 100, delta: null },
  },
  window: { from: "2026-09-10T00:00:00.000Z", to: "2026-09-17T00:00:00.000Z" },
  missing: [
    "No feedback is not approval.",
    "Task-contract acceptance is unavailable.",
    "Not enough runs to tell",
  ],
};
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
    ...(status === "applied" ? { documentId: "document", appliedRevisionId: "document:1" } : {}),
    expiresAt: "2099-01-01T00:00:00.000Z",
  });
  await page.route("**/rpc/learning/**", async (route) => {
    const action = new URL(route.request().url()).pathname.split("/").at(-1);
    if (action === "approve") status = "applied";
    if (action === "revert") status = "reverted";
    const json =
      action === "observation"
        ? observation
        : action === "journey"
          ? [
              {
                id: "audit:one",
                action: "applied",
                at: "2026-09-10T00:00:00.000Z",
                proposalId: "proposal",
                documentId: "document",
                revisionId: "document:1",
              },
            ]
          : action === "list" || action === "summary"
            ? {
                reviews: [],
                proposals: [proposal()],
                pendingCount: status === "pending" ? 3 : 0,
                appliedThisWeek: status === "applied" ? 1 : 0,
              }
            : action === "settings"
              ? {
                  enabled: true,
                  canConfigure: true,
                  consolidationEnabled: false,
                  reviewerPin: null,
                  destination: null,
                  budgets: {},
                }
              : action === "curator"
                ? {
                    skills: [],
                    reports: [
                      {
                        id: "check",
                        startedAt: "2026-09-17T00:00:00.000Z",
                        completedAt: "2026-09-17T00:00:00.100Z",
                        status: "completed",
                        checked: 2,
                        staleIds: [],
                        flaggedIds: ["document:1"],
                        proposalIds: [],
                        durationMs: 100,
                        tokens: 0,
                      },
                    ],
                  }
                : action === "proposal"
                  ? proposal()
                  : action === "curate"
                    ? { ok: true }
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
  await expect(inbox.getByText("Not enough runs to tell", { exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "learning-inbox-applied");
  await inbox.getByRole("tab", { name: "Timeline", exact: true }).click();
  await expect(inbox.getByText("document:1", { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "learning-timeline");
  await inbox.getByRole("tab", { name: "Inbox", exact: true }).click();
  await inbox.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(inbox.getByText("Undone", { exact: true })).toBeVisible();
  await inbox.getByText("Curator", { exact: true }).click();
  await inbox.getByRole("button", { name: "Run now", exact: true }).click();
  await inbox.getByText("Last check", { exact: true }).click();
  await expect(inbox.getByText("Propose consolidation", { exact: true })).toBeVisible();
  await expect(inbox.getByText("completed", { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "learning-curator-last-check");
});

test("learning inbox shows board-item suggestions, their outcome, and a close that keeps failing", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = dashboardFixture();
  const boardProposal = (id: string, title: string, extra: Record<string, unknown>) => ({
    id,
    type: "board-item",
    scope: { spaceId: "space", userId: "fixture-user", botId: "bot" },
    target: {},
    expectedBaseRevision: 0,
    boardItem: {
      title,
      description: "The run stopped before the import finished.",
      acceptanceCriteria: "The import completes.",
      labels: ["import", "follow-up"],
    },
    rationale: "The reviewed run left this unfinished.",
    evidenceIds: ["evidence"],
    confidence: { label: "model estimate", value: 0.7 },
    diff: "",
    status: "pending",
    expiresAt: "2099-01-01T00:00:00.000Z",
    ...extra,
  });
  const proposals = [
    boardProposal("pending", "Finish the import follow-up", {}),
    boardProposal("applied", "Retry the failed export", {
      status: "applied",
      appliedAt: "2026-09-24T12:00:00.000Z",
      appliedBoardItem: {
        workspaceId: "board",
        itemId: "work-2",
        updatedAt: "2026-09-24T12:00:00.000Z",
        commentCount: 0,
        duplicate: false,
      },
      boardOutcome: {
        closedAt: "2026-09-24T13:00:00.000Z",
        outcome: "closed-other",
        closeReason: "Duplicate, fixed in work-9",
      },
    }),
    boardProposal("failing", "Check the nightly sync", {
      status: "rejected",
      boardClosing: true,
      boardCloseFailed: true,
    }),
  ];
  const learning = (action: string | undefined) =>
    action === "list" || action === "summary"
      ? {
          reviews: [],
          proposals,
          pendingCount: 1,
          appliedThisWeek: 1,
          botNames: { bot: "Reviewer" },
        }
      : action === "settings"
        ? {
            enabled: true,
            canConfigure: true,
            consolidationEnabled: false,
            reviewerPin: null,
            destination: null,
            budgets: {},
          }
        : action === "grants"
          ? { grants: [], offers: [] }
          : action === "curator"
            ? { skills: [], reports: [] }
            : action === "proposal"
              ? proposals[0]
              : [];
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    const json = procedure.startsWith("learning/")
      ? learning(procedure.split("/").at(-1))
      : fixture.rpc(procedure, route.request().postDataJSON()?.json);
    await route.fulfill({ json: { json } });
  });
  await page.goto("/app");
  await expect(page.locator('[data-panel="work"]')).toContainText(
    "Reviewer filed 3: 1 done, 1 open, 0 closed, 1 closed without being completed.",
  );
  await page.locator('[data-panel="learning"]').getByRole("button", { name: "Inbox (1)" }).click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByText("Finish the import follow-up", { exact: true })).toBeVisible();
  await expect(dialog.getByText("A board item filed by a bot could not be closed.")).toBeVisible();
  await expect(
    dialog.getByText(
      "Ardur Bot tried five times. Close it on the Board, or check that this computer is connected.",
      { exact: true },
    ),
  ).toBeVisible();
  for (const details of await dialog.getByText("Details", { exact: true }).all())
    await details.click();
  await expect(dialog.getByText("Labels: import, follow-up").first()).toBeVisible();
  await expect(
    dialog.getByText(
      "This board item was closed without being completed: Duplicate, fixed in work-9. Review it on the Board.",
    ),
  ).toBeVisible();
  await captureScreenshot(page, testInfo, "learning-inbox-board-items");
});
