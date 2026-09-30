import type { ComputerStatus } from "@ardurbot/contracts";
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
    state: "stopped",
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
            ? []
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
  await expect(summary).toContainText("Stopped");
  await expect(settings.getByTestId("bot-settings-advanced")).not.toHaveAttribute("open", "");
  await summary.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "bot-runtime-settings-host");
  await settings.getByRole("button", { name: "Only this bot", exact: true }).click();
  await expect(summary).toContainText("Runs as you; can use your files and signed-in tools");
  expect(mutations).toEqual([]);
});
