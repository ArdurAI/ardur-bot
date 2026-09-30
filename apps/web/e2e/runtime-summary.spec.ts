import type { ComputerStatus, ComputerUpdate } from "@ardurbot/contracts";
import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot } from "./helpers";

test("bot settings show execution location outside Advanced before saving", async ({
  page,
}, testInfo) => {
  const fixture = dashboardFixture();
  const status: ComputerStatus = {
    botId: "bot",
    computerId: "computer",
    kind: "desktop",
    mode: "team",
    state: "suspending",
    connectionId: null,
    imageProfile: "base",
    controlHolder: "none",
    controlBotId: null,
    takeoverRequested: false,
    screenAvailable: false,
    screenWidth: 1280,
    screenHeight: 800,
    homeRevision: "saved",
    busyBotName: null,
    canUpdate: false,
  };
  const mutations: string[] = [];
  const update: ComputerUpdate = {
    id: "interrupted-update",
    computerId: "computer",
    botId: "bot",
    name: "Reviewer",
    mode: "team",
    action: "update",
    status: "interrupted",
    stage: "saving",
    canReleaseReservation: true,
  };
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (
      procedure === "bots/setComputer" ||
      procedure === "computer/configure" ||
      procedure === "computer/boot"
    )
      mutations.push(procedure);
    const result =
      procedure === "computer/status"
        ? status
        : procedure === "computer/list"
          ? [{ botId: "bot", name: "Reviewer", status }]
          : procedure === "computer/connections"
            ? [{ id: "container", name: "Container engine", settings: { engine: "docker" } }]
            : procedure === "computer/updates"
              ? [update]
              : procedure === "computer/engine"
                ? { name: "docker", rootless: false }
                : fixture.rpc(procedure, route.request().postDataJSON()?.json);
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/app/bot");
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  const summary = settings.getByTestId("runtime-summary");
  await expect(summary).toContainText("This computer");
  await expect(summary).toContainText("Runs as you; can use your files and signed-in tools");
  await expect(summary).toContainText("Shared with team");
  await expect(summary).toContainText("Paused for an update");
  await expect(summary).not.toContainText("Starting");
  await expect(settings).toContainText("The last update was interrupted.");
  await expect(
    settings.getByRole("button", { name: "Release computer", exact: true }),
  ).toBeVisible();
  await expect(settings.getByTestId("bot-settings-advanced")).not.toHaveAttribute("open", "");
  await summary.scrollIntoViewIfNeeded();
  await settings.getByText("Change location", { exact: true }).click();
  await expect(settings.getByRole("combobox", { name: "Connection", exact: true })).toBeVisible();
  await settings
    .getByRole("combobox", { name: "Connection", exact: true })
    .selectOption("container");
  await expect(settings).toContainText("Move to a container");
  await expect(settings).not.toContainText("Engine: Docker");
  await expect(settings.getByTestId("runtime-summary")).toHaveCount(1);
  for (const fact of [
    "This computer",
    "Runs as you; can use your files and signed-in tools",
    "Bots share files and installed tools",
    "Paused for an update",
  ]) {
    await expect(settings.getByText(fact, { exact: true })).toHaveCount(1);
  }
  await captureScreenshot(page, testInfo, "bot-runtime-settings-host");
  await settings.getByRole("button", { name: "Only this bot", exact: true }).click();
  await expect(summary).toContainText("Runs as you; can use your files and signed-in tools");
  expect(mutations).toEqual([]);
});
