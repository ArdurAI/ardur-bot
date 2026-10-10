import type { AppBootstrap, FailureCategoryId } from "@ardurbot/contracts";
import { failureCategoryMessage, runtimePinProblem } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot } from "./helpers";

const cases: readonly (readonly [FailureCategoryId, string])[] = [
  ["runtime-stopped", "codex-runtime-stopped-retry"],
  ["usage-limit", "codex-usage-limit-retry"],
];
for (const [category, screenshot] of cases) {
  test(`a pinned Codex failure names ${category} without private detail`, async ({
    page,
  }, testInfo) => {
    const fixture = dashboardFixture();
    const pin = {
      runtimeKind: "codex-app-server" as const,
      provider: "openai-codex",
      modelId: "fixture-model",
      effort: "off",
      credentialId: "fixture-connection",
      revision: 1,
    };
    const reason = failureCategoryMessage(category, { runtime: "Codex" });
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
          runtimeProblem: {
            ...runtimePinProblem(pin, "runtime-unavailable", reason, category),
            actions: ["retry"],
            failure: {
              step: "stream",
              errorClass: "CodexTransportError",
              message: "private protocol detail",
              exitCode: 17,
              signal: null,
              retryable: true,
              retries: 3,
            },
          },
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
    await expect(error.getByRole("button", { name: "Change pin", exact: true })).toHaveCount(0);
    await error.getByRole("button", { name: "Retry", exact: true }).click();
    await expect(page.getByRole("combobox", { name: /^Message / })).toHaveValue(
      "Continue the interrupted run from its saved results. Check any uncertain action before repeating it.",
    );
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeEnabled();
  });
}
