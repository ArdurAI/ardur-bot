import { failureCategoryMessage } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";
import { installPerformanceFixture } from "./performance-fixture";

test("can-run-settings", async ({ page }, testInfo) => {
  await installPerformanceFixture(page);
  const sentence = failureCategoryMessage("computer-unsupported", {
    runtime: "Codex",
    bot: "this bot",
  });
  let moves = 0;
  await page.route("**/rpc/computer/status", (route) =>
    route.fulfill({
      json: { json: { botId: "fixture-bot-0", kind: "docker", mode: "team", state: "stopped" } },
    }),
  );
  await page.route("**/rpc/host/status", (route) =>
    route.fulfill({ json: { json: { connected: true } } }),
  );
  await page.route("**/rpc/computer/configure", (route) => {
    moves++;
    return route.fulfill({ json: { json: {} } });
  });
  await page.route("**/rpc/runtimes/availability", (route) =>
    route.fulfill({
      json: {
        json: { runtimeKind: "codex-app-server", available: true, signedIn: true, models: [] },
      },
    }),
  );
  await page.route("**/rpc/models/validatePin", (route) => {
    const request = route.request();
    const data =
      request.postDataJSON()?.json ??
      JSON.parse(new URL(request.url()).searchParams.get("data") ?? "{}").json ??
      {};
    return data.runtimeKind === "codex-app-server"
      ? route.fulfill({
          status: 400,
          json: { json: { defined: false, code: "BAD_REQUEST", status: 400, message: sentence } },
        })
      : route.fulfill({ json: { json: { ok: true } } });
  });
  await page.goto("/app/fixture-bot-0");
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  await settings.getByRole("combobox", { name: "Runs on" }).selectOption("codex-app-server");
  await expect(settings.getByText("Experimental turned on for this runtime")).toBeVisible();
  await expect(settings.getByRole("switch", { name: "Experimental" })).toBeChecked();
  await expect(settings.getByRole("alert").filter({ hasText: sentence })).toBeVisible();
  await expect(settings.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  const move = settings.getByRole("button", { name: "Move to This computer" });
  await expect(move).toBeEnabled();
  expect(moves).toBe(0);
  await captureScreenshot(page, testInfo, "can-run-settings");
  await settings.getByRole("button", { name: "Save", exact: true }).scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "can-run-settings-refusal");
  await move.click();
  await expect(page.getByRole("alertdialog")).toContainText(
    "This replaces the computer's files. Continue?",
  );
  expect(moves).toBe(0);
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  expect(moves).toBe(0);
  await settings.getByRole("switch", { name: "Experimental" }).click();
  await expect(settings.getByRole("switch", { name: "Experimental" })).not.toBeChecked();
  await expect(settings.getByText("Experimental turned on for this runtime")).not.toBeVisible();
});
