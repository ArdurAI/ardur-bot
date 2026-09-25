import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, signup } from "./helpers";

test("Board route shows dependencies across five columns", async ({ page }, testInfo) => {
  await signup(page, `board-${Date.now()}@ardurbot.test`, "password12", "Board owner");
  await completeOnboarding(page);
  const items = ["open", "in_progress", "blocked", "deferred", "closed"].map((status, index) => ({
    id: `board-${index}`,
    title: ["Prepare schema", "Review contract", "Build view", "Explore export", "Write tests"][
      index
    ],
    type: "task",
    status,
    priority: 2,
    assignee: null,
    description: "",
    acceptanceCriteria: "",
    labels: [],
    parent: null,
    dependencies: [],
    dueAt: null,
    deferUntil: null,
    estimateMinutes: null,
    externalRef: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    closedAt: status === "closed" ? new Date().toISOString() : null,
    commentCount: 0,
    comments: [],
    history: [],
    closeWhenDone: false,
  }));
  await page.route("**/rpc/board/workspaces", (route) =>
    route.fulfill({
      json: {
        json: {
          workspaces: [
            {
              id: "board",
              kind: "space",
              name: "Board",
              path: "/fixture/board",
              prefix: "board",
              enabled: true,
              initialized: true,
            },
          ],
          problem: null,
        },
      },
    }),
  );
  await page.route("**/rpc/board/snapshot", (route) =>
    route.fulfill({ json: { json: { items, readyIds: ["board-0"], blockedIds: ["board-2"] } } }),
  );
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/board$/);
  await expect(page.locator("[data-board-column]")).toHaveCount(5);
  await expect(page.locator('[data-board-column="ready"]')).toContainText("Prepare schema");
  await expect(page.locator('[data-board-column="blocked"]')).toContainText("Build view");
  await captureScreenshot(page, testInfo, "beads-board");
});
