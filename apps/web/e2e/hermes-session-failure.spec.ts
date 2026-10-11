import type { AppBootstrap, FailureCategoryId } from "@ardurbot/contracts";
import { failureCategoryMessage, runtimePinProblem } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot } from "./helpers";

const cases: readonly (readonly [FailureCategoryId, string])[] = [
  ["model-context-too-small", "hermes-context-floor-recovery"],
  ["runtime-tool-catalog-mismatch", "hermes-runtime-tool-catalog-mismatch"],
  ["runtime-profile-unacknowledged", "hermes-runtime-profile-unacknowledged"],
  ["provider-request-too-large", "hermes-provider-request-too-large"],
  ["provider-response-too-large", "hermes-provider-response-too-large"],
  ["provider-grant-refused", "hermes-provider-grant-refused"],
  ["provider-auth-failed", "hermes-provider-auth-failed"],
  ["provider-request-failed", "hermes-provider-request-failed"],
  ["provider-rate-limit", "hermes-provider-rate-limit"],
];
for (const [category, screenshot] of cases) {
  test(`a pinned Hermes failure names ${category} without private detail`, async ({
    page,
  }, testInfo) => {
    const fixture = dashboardFixture();
    const pin = {
      runtimeKind: "hermes" as const,
      provider: category === "provider-rate-limit" ? "zai-coding-cn" : "openai-compatible",
      modelId: category === "provider-rate-limit" ? "glm-5.3" : "fixture-model",
      effort: category === "provider-rate-limit" ? "high" : "off",
      credentialId: "fixture-connection",
      revision: 1,
    };
    const reason = failureCategoryMessage(category, {
      runtime: "Hermes",
      provider: "Z.AI Coding CN",
    });
    const problem = runtimePinProblem(pin, "runtime-unavailable", reason, category);
    if (category === "provider-rate-limit") problem.actions = ["retry"];
    await page.route("**/api/auth/get-session*", (route) =>
      route.fulfill({ json: fixture.session }),
    );
    await page.route("**/rpc/**", async (route) => {
      const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
      if (procedure === "threads/subscribe")
        return route.fulfill({ contentType: "text/event-stream", body: "" });
      const result = fixture.rpc(procedure, route.request().postDataJSON()?.json);
      const failedThread = (thread: NonNullable<AppBootstrap["thread"]>) => ({
        ...thread,
        messages: [],
        run: {
          id: "context-failure",
          botId: "bot",
          threadId: "thread",
          taskId: "task",
          status: "failed",
          trigger: "user",
          runtimePin: pin,
          error: "private protocol detail",
          runtimeProblem: problem,
          createdAt: "2026-10-02T12:00:00.000Z",
          completedAt: "2026-10-02T12:00:00.000Z",
        },
      });
      if (procedure === "bootstrap") {
        const bootstrap = result as AppBootstrap;
        if (bootstrap.thread)
          bootstrap.thread = failedThread(bootstrap.thread) as AppBootstrap["thread"];
      } else if (procedure === "threads/get" || procedure === "threads/head") {
        return route.fulfill({
          json: { json: failedThread(result as NonNullable<AppBootstrap["thread"]>) },
        });
      }
      await route.fulfill({ json: { json: result } });
    });
    await page.goto("/app/bot");
    const error = page.getByTestId("composer-error");
    await expect(error).toContainText(reason);
    await expect(error).not.toContainText("private protocol detail");
    await captureScreenshot(page, testInfo, screenshot);
    if (category === "provider-rate-limit") {
      await expect(error).not.toContainText("Hermes");
      await expect(error.getByRole("button", { name: "Retry", exact: true })).toBeVisible();
      return;
    }
    await error.getByRole("button", { name: "Change pin", exact: true }).click();
    await expect(
      page.getByTestId("bot-settings").getByRole("combobox", { name: "Model", exact: true }),
    ).toBeFocused();
  });
}
