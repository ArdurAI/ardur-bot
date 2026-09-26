import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot } from "./helpers";

const sonnet = { key: "pi|anthropic|claude-sonnet|medium", label: "Claude Sonnet", local: false };
const gpt = { key: "pi|openai|gpt-4.1|medium", label: "GPT-4.1", local: false };
const row = (model: typeof sonnet, completed: number, total: number, medianTokens: number) => ({
  model,
  completed,
  total,
  thumbsUp: 2,
  thumbsDown: total - completed > 3 ? 1 : 0,
  medianMs: 48_000,
  medianTokens,
  costUsd: null,
});
const insight = (id: string, evidence: object, action: object) => ({
  id,
  botId: "bot",
  status: "active",
  evidence,
  action,
  createdAt: "2026-09-26T00:00:00.000Z",
  expiresAt: "2026-09-28T00:00:00.000Z",
});

test("learning shows insights with their evidence, and Dismiss hides one", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const fixture = dashboardFixture();
  let insights = [
    insight(
      "model",
      {
        kind: "model-choice",
        variant: "completion",
        taskKind: "coding",
        botName: "Reviewer",
        better: sonnet,
        other: gpt,
        rows: [row(sonnet, 9, 10, 18_000), row(gpt, 3, 7, 31_000)],
        runs: 17,
        days: 30,
      },
      { kind: "bot-model", botId: "bot" },
    ),
    insight(
      "approval",
      {
        kind: "approval",
        botName: "Reviewer",
        tool: "notion_update_page",
        approvals: 12,
        days: 7,
      },
      { kind: "approval-rule", botId: "bot", tool: "notion_update_page" },
    ),
    insight(
      "routine",
      {
        kind: "routine",
        botName: "Reviewer",
        prompt: "Summarize the open pull requests",
        count: 4,
        days: 14,
      },
      { kind: "routine", botId: "bot", prompt: "Summarize the open pull requests" },
    ),
  ];
  const learning = (action: string | undefined) =>
    action === "list" || action === "summary"
      ? {
          reviews: [],
          proposals: [],
          pendingCount: 0,
          appliedThisWeek: 0,
          insightCount: insights.length,
          botNames: { bot: "Reviewer" },
        }
      : action === "insights"
        ? { insights }
        : action === "dismissInsight"
          ? { ok: true }
          : action === "settings"
            ? {
                enabled: true,
                canConfigure: true,
                consolidationEnabled: false,
                insightsEnabled: true,
                reviewerPin: null,
                destination: null,
                budgets: {},
              }
            : action === "grants"
              ? { grants: [], offers: [] }
              : action === "curator"
                ? { skills: [], reports: [] }
                : [];
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    const action = procedure.split("/").at(-1);
    if (procedure === "learning/dismissInsight") {
      const { insightId } = route.request().postDataJSON().json;
      insights = insights.filter((item) => item.id !== insightId);
    }
    const json = procedure.startsWith("learning/")
      ? learning(action)
      : fixture.rpc(procedure, route.request().postDataJSON()?.json);
    await route.fulfill({ json: { json } });
  });
  await page.goto("/app");
  await page
    .locator('[data-panel="learning"]')
    .getByRole("button", { name: "Insights (3)" })
    .click();
  const section = page.getByRole("dialog").getByTestId("learning-insights");
  await expect(
    section.getByText(
      "For coding, Claude Sonnet finished 9 of 10 runs in your runs; GPT-4.1 finished 3 of 7.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(
    section.getByText("You approved notion_update_page for Reviewer 12 times this week.", {
      exact: true,
    }),
  ).toBeVisible();
  await section.getByText("Details", { exact: true }).first().click();
  await expect(
    section.getByText("Based on 17 runs in the last 30 days.", { exact: true }),
  ).toBeVisible();
  await expect(section.getByRole("table")).toContainText("9/10");
  await captureScreenshot(page, testInfo, "learning-insights");

  await section
    .getByTestId("learning-insight")
    .filter({ hasText: "same request" })
    .getByRole("button", { name: "Dismiss", exact: true })
    .click();
  await expect(section.getByText("same request", { exact: false })).toHaveCount(0);
  await expect(section.getByTestId("learning-insight")).toHaveCount(2);
});
