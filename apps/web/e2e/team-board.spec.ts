import { expect, test } from "@playwright/test";
import { captureScreenshot, completeOnboarding, rpc, signup } from "./helpers";

test("Team opens as a board with one row per bot", async ({ page }, testInfo) => {
  await signup(page, `team-${Date.now()}@example.test`, "password12", "Team");
  await completeOnboarding(page);
  await expect(page.getByRole("button", { name: "Team", exact: true })).toHaveCount(0);
  await rpc(page, "bots/create", {
    name: "Reviewer",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  await page.getByRole("button", { name: "Team", exact: true }).click();
  await expect(page).toHaveURL(/\/app\/team$/);
  await expect(page.locator("[data-team-bot]")).toHaveCount(2);
  await expect(page.getByRole("heading", { name: "Team", exact: true })).toBeVisible();
  await expect(page.locator("main").getByRole("combobox")).toHaveCount(0);
  const reviewer = page.locator("[data-team-bot]").filter({ hasText: "Reviewer" });
  await reviewer.locator("summary").click();
  await expect(reviewer.getByText("Tokens", { exact: false })).toBeVisible();
  await captureScreenshot(page, testInfo, "delegation-team-board");
});

test("Team keeps direct work and blocked reasons readable", async ({ page }, testInfo) => {
  await signup(page, `team-presence-${Date.now()}@example.test`, "password12", "Team");
  await completeOnboarding(page);
  await rpc(page, "bots/create", {
    name: "Reviewer",
    title: "",
    description: "",
    instructions: "",
    notifyOnFinish: true,
  });
  await page.reload();
  let blocked = false;
  await page.route("**/rpc/team/board", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    const rows = body.json.rows.map((row: Record<string, unknown>, index: number) =>
      index === 0
        ? {
            ...row,
            state: blocked ? "blocked" : "working",
            availability: blocked ? "unavailable" : "busy",
            observedAt: new Date().toISOString(),
            currentTaskTitle: "Review the notes",
            sentence: null,
            requesterName: null,
            reason: blocked ? "Computer stopped" : null,
          }
        : row,
    );
    await route.fulfill({ response, json: { json: { ...body.json, rows } } });
  });
  await page.getByRole("button", { name: "Team", exact: true }).click();
  const row = page.locator("[data-team-bot]").first();
  await expect(row).toContainText("Working");
  await expect(row).not.toContainText("Review the notes for");
  blocked = true;
  await page.reload();
  await expect(row).toContainText("Blocked — Computer stopped");
  await captureScreenshot(page, testInfo, "team-blocked-reason");
});
