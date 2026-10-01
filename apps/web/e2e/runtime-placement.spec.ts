import { expect, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";
import { captureScreenshot } from "./helpers";

test("a host runtime offers This computer without mislabeling its current container", async ({
  page,
}, testInfo) => {
  const fixture = dashboardFixture();
  const mutations: string[] = [];
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    if (["computer/configure", "computer/boot", "bots/setComputer"].includes(procedure))
      mutations.push(procedure);
    let result = fixture.rpc(procedure, route.request().postDataJSON()?.json);
    const pin = { runtimeKind: "codex-app-server", runtimeExperimental: true };
    if (procedure === "bootstrap") {
      const bootstrap = result as { bots: object[] };
      result = { ...bootstrap, bots: bootstrap.bots.map((bot) => ({ ...bot, ...pin })) };
    } else if (procedure === "bots/list")
      result = (result as object[]).map((bot) => ({ ...bot, ...pin }));
    else if (procedure === "bots/get") result = { ...(result as object), ...pin };
    else if (procedure === "host/status")
      result = { configured: true, connected: true, roots: [], health: null };
    else if (procedure === "computer/status")
      result = {
        botId: "bot",
        computerId: "computer",
        kind: "desktop",
        mode: "team",
        state: "stopped",
        connectionId: "container",
        imageProfile: "base",
        controlHolder: "none",
        controlBotId: null,
        takeoverRequested: false,
        screenAvailable: false,
        screenWidth: 1280,
        screenHeight: 800,
        homeRevision: "saved",
        busyBotName: null,
        canUpdate: true,
      };
    else if (procedure === "computer/connections")
      result = [{ id: "container", name: "Docker Desktop", settings: { engine: "docker" } }];
    else if (procedure === "computer/updates") result = [];
    await route.fulfill({ json: { json: result } });
  });
  await page.goto("/app/bot");
  await page.getByTestId("bot-settings-trigger").click();
  const settings = page.getByTestId("bot-settings");
  const summary = settings.getByTestId("runtime-summary");
  try {
    await expect(summary).toContainText("Container");
  } catch (error) {
    throw new Error(
      `Location panel: ${await settings.innerText()}; browser errors: ${browserErrors.join("; ")}`,
      { cause: error },
    );
  }
  await expect(summary).toContainText("Docker Desktop");
  await expect(summary).not.toContainText("Runs as you");
  await settings.getByText("Change location", { exact: true }).click();
  const select = settings.getByRole("combobox", { name: "Connection", exact: true });
  await expect(select.locator("option")).toHaveText(["Keep current location", "This computer"]);
  await expect(settings).toContainText(
    "Other locations are unavailable for Codex. Choose This computer.",
  );
  await select.selectOption("host-computer");
  await expect(settings).toContainText("Runs as you; can use your files and signed-in tools");
  await select.scrollIntoViewIfNeeded();
  await captureScreenshot(page, testInfo, "host-runtime-location-choice");
  expect(mutations).toEqual([]);
});
