import { expect, type Page, test } from "@playwright/test";
import {
  activeBotId,
  captureScreenshot,
  completeOnboarding,
  realSandboxTimeout,
  rpc,
  signup,
} from "./helpers";

function sidebarBotButton(page: Page, name: RegExp | string) {
  return page.locator("[data-sidebar-group] [data-roster-bot-id]").filter({
    has: page.locator("[data-roster-bot-name]").filter({ hasText: name }),
  });
}

test.describe.configure({ mode: "serial" });

test("two users are isolated and a bot completes durable work", async ({ browser }, testInfo) => {
  const a = await browser.newContext();
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  const stamp = Date.now();
  await signup(pageA, `ada-${stamp}@ardurbot.test`, "password12", "Ada", testInfo);
  await completeOnboarding(pageA, testInfo);
  await expect(pageA.getByText("Chief").first()).toBeVisible();

  await signup(pageB, `bob-${stamp}@ardurbot.test`, "password12", "Bob");
  await completeOnboarding(pageB);
  await expect(pageB.getByText("Chief").first()).toBeVisible();
  await expect(pageB.getByText("Ada", { exact: true })).toHaveCount(0);

  const composer = pageA.getByPlaceholder(/Message/);
  await composer.fill("write a file in your home called notes/result.txt that says isolation-ok");
  await pageA.keyboard.press("Enter");
  await expect(
    pageA.getByText(/writing that into my home|isolation-ok|handled/i).first(),
  ).toBeVisible({
    timeout: 30_000,
  });

  await pageA.reload();
  await expect(pageA.getByText(/isolation-ok|writing that into my home/i).first()).toBeVisible();
  await captureScreenshot(pageA, testInfo, "07-durable-bot-work");

  await a.close();
  await b.close();
});

test("takeover, routine, integrations, and export are reachable", async ({ page }, testInfo) => {
  const stamp = Date.now();
  await signup(page, `flow-${stamp}@ardurbot.test`, "password12", "Flow");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Message/);
  await composer.fill("install the gsc cli and sign in");
  await page.keyboard.press("Enter");
  await expect(
    page.getByText(/handing you the computer|sign in to continue|protected input/i).first(),
  ).toBeVisible({ timeout: realSandboxTimeout(90_000, 30_000) });
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  const computerCard = page.getByTestId("computer-card");
  await expect(computerCard).toBeVisible();
  await expect(computerCard.getByText("Needs you", { exact: true })).toBeVisible();
  await expect(computerCard.getByTestId("computer-card-open")).toBeVisible();
  await captureScreenshot(page, testInfo, "08-protected-input-request");
  await computerCard.getByTestId("computer-card-open").click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Skip", exact: true }).last()).toBeVisible();
  await expect(page.getByRole("button", { name: "I’m done", exact: true }).last()).toBeVisible();
  if (process.env.SANDBOX_PROVIDER === "box") await waitForBoxFramebuffer(page);
  await captureScreenshot(page, testInfo, "09-computer-takeover-outcomes");
  await page.getByRole("button", { name: "I’m done", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/signed in|session stays/i).first()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });

  await composer.fill("sign in again so I can skip this time");
  await page.keyboard.press("Enter");
  await expect
    .poll(() => threadRunStatus(page), {
      timeout: realSandboxTimeout(90_000, 30_000),
      message: "the second protected-input run must be ready for takeover",
    })
    .toBe("waiting_takeover");
  // Agent computer toggles the panel. Re-open when closed so Open can refresh computer status.
  const sidePanel = page.getByTestId("side-panel");
  if ((await sidePanel.getAttribute("data-panel")) === "computer") {
    await page.getByTitle("Agent computer").click();
  }
  await page.getByTitle("Agent computer").click();
  await expect(sidePanel).toHaveAttribute("data-panel", "computer");
  await expect(sidePanel).toHaveCSS("width", "384px");
  const [mainBox, panelBox] = await Promise.all([
    page.locator("main").boundingBox(),
    sidePanel.boundingBox(),
  ]);
  expect(mainBox).not.toBeNull();
  expect(panelBox).not.toBeNull();
  expect((mainBox?.x ?? 0) + (mainBox?.width ?? 0)).toBeLessThanOrEqual(panelBox?.x ?? 0);
  await sidePanel.getByTestId("computer-preview").hover();
  const openComputer = sidePanel.getByTestId("computer-preview-open");
  await expect(openComputer).toBeVisible({ timeout: 30_000 });
  await openComputer.click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeVisible();
  await page.getByRole("button", { name: "Skip", exact: true }).last().click();
  await expect(page.getByRole("button", { name: "Close computer" })).toBeHidden();
  await expect(page.getByText(/login was skipped/i).last()).toBeVisible({
    timeout: realSandboxTimeout(90_000, 30_000),
  });
  await captureScreenshot(page, testInfo, "09a-computer-takeover-skipped");

  await page.getByRole("button", { name: "Create Routine" }).click();
  await page.locator("label:has-text('Name') input").fill("Monday briefing");
  await page
    .locator("label:has-text('Instruction') textarea")
    .fill("write a file in your home called notes/result.txt that says routine-ok");
  await page.getByRole("button", { name: "Add trigger" }).click();
  await page.getByRole("menuitem", { name: "On a schedule" }).hover();
  await page.getByRole("menuitem", { name: "Every day", exact: true }).click();
  const savedRoutine = page.waitForResponse(
    (response) => response.url().includes("/rpc/routines/create") && response.ok(),
  );
  await page.getByRole("button", { name: "Save" }).click();
  await savedRoutine;
  await expect(page.getByRole("button", { name: "Save" })).toBeEnabled();
  await page.getByRole("button", { name: "Back" }).click();
  await expect(page.getByText("Monday briefing")).toBeVisible();
  await captureScreenshot(page, testInfo, "10-routine-created");

  await page
    .locator("aside")
    .first()
    .getByRole("button", { name: "Integrations", exact: true })
    .click();
  const userSettings = page.getByTestId("user-settings");
  await expect(userSettings).toHaveAttribute("data-settings-section", "integrations");
  await expect(userSettings.getByTestId("integration-github")).toBeVisible();
  await expect(page.getByPlaceholder("Search apps")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "11-integrations-catalog");
  await userSettings.getByTestId("settings-nav-mcp").click();
  await expect(userSettings.getByRole("heading", { name: "Manage MCP servers" })).toBeVisible();
  await expect(userSettings.getByLabel("Server name")).toHaveCount(0);
  await userSettings.getByRole("button", { name: "Add MCP server", exact: true }).click();
  await userSettings.getByLabel("Server name").fill("Browser MCP");
  await userSettings.getByLabel("Server URL").fill("https://mcp.example.test/mcp");
  await userSettings.getByRole("button", { name: "Add server", exact: true }).click();
  await expect(userSettings.getByText("Browser MCP", { exact: true })).toBeVisible();
  await expect(userSettings.getByLabel("Server name")).toHaveCount(0);
  await captureScreenshot(page, testInfo, "11a-mcp-servers");
  await userSettings.getByRole("button", { name: "Close user settings" }).click();

  await page.getByText("Chief").first().click();
  const gear = page.getByRole("button", { name: "Show settings" });
  if (!(await gear.isVisible().catch(() => false))) {
    await page.getByTitle("Agent computer").click();
  }
  await gear.click();
  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "Export" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/chief-export\.json/i);
  const settings = page.getByTestId("bot-settings");
  await expect(settings.getByRole("button", { name: "Archive bot" })).toHaveCount(0);
  await expect(settings.getByRole("button", { name: "Delete bot" })).toHaveCount(0);
  await page.getByRole("button", { name: "Close panel" }).click();

  await page.locator("aside").first().getByRole("button", { name: /Chief/ }).first().click({
    button: "right",
  });
  const botMenu = page.getByRole("menu", { name: "Actions for Chief" });
  await expect(botMenu.getByRole("menuitem", { name: "Archive" })).toBeVisible();
  await botMenu.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("radio", { name: /Keep memories/ })).toBeChecked();
  await expect(page.getByRole("radio", { name: /Delete memories too/ })).toBeVisible();
  await page.getByRole("button", { name: "Cancel" }).click();
  await captureScreenshot(page, testInfo, "12-bot-settings");
});

test("sign-in, spawn, and stop work in the shell", async ({ page }, testInfo) => {
  const browserErrors: string[] = [];
  const failedRequests: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") browserErrors.push(message.text());
  });
  page.on("requestfailed", (request) => {
    // AuthPage cancels its capability lookup when the auth route unmounts.
    if (
      new URL(request.url()).pathname === "/api/auth/capabilities" &&
      request.failure()?.errorText === "net::ERR_ABORTED"
    ) {
      return;
    }
    failedRequests.push(
      `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
    );
  });
  const stamp = Date.now();
  const email = `shell-${stamp}@ardurbot.test`;
  await signup(page, email, "password12", "Shell");
  await completeOnboarding(page);
  await page.evaluate(() => {
    Object.defineProperty(globalThis.crypto, "randomUUID", {
      value: undefined,
      configurable: true,
    });
  });

  const composer = page.locator('textarea[name="chat-message"]');
  await composer.fill("spawn a bot named Scout to research venues");
  await page.keyboard.press("Enter");
  await expect(sidebarBotButton(page, /Scout/)).toBeVisible({
    timeout: 30_000,
  });
  await captureScreenshot(page, testInfo, "13-spawned-bot");

  await page
    .locator("[data-sidebar-group]")
    .getByRole("button", { name: /^Chief/ })
    .click();
  await composer.fill("keep working until I stop you");
  await page.keyboard.press("Enter");
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByTestId("composer-steering-status")).toHaveCount(0);
  await expect(page.getByText("Messages sent now guide the next turn.")).toHaveCount(0);
  await expect(page.getByText(/^Steer /)).toHaveCount(0);
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await composer.fill("Use the newer report and keep the answer short.");
  await page.keyboard.press("Tab");
  await expect(
    page.getByTestId("composer-bar").getByRole("button", { name: "Voice", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(
    page.getByTestId("transcript").getByText("Use the newer report and keep the answer short."),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await captureScreenshot(page, testInfo, "14-active-bot-work");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeVisible();
  await expect(composer).toHaveAttribute("placeholder", "Message Chief");
  await captureScreenshot(page, testInfo, "14-active-bot-work-mobile");
  await page.setViewportSize({ width: 1280, height: 720 });
  expect(browserErrors).toEqual([]);
  expect(failedRequests).toEqual([]);
  let releaseStopRequest: () => void = () => undefined;
  let markStopRequestStarted: () => void = () => undefined;
  const stopRequestStarted = new Promise<void>((resolve) => {
    markStopRequestStarted = resolve;
  });
  await page.route("**/rpc/threads/stop", async (route) => {
    markStopRequestStarted();
    await new Promise<void>((release) => {
      releaseStopRequest = release;
    });
    await route.continue();
  });
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await stopRequestStarted;
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toBeDisabled();
  releaseStopRequest();
  // Idle Send stays disabled with an empty draft; wait for Stop to leave instead.
  await expect(page.getByRole("button", { name: "Stop", exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();

  await page.context().clearCookies();
  await page.goto("/sign-in");
  await page.getByPlaceholder("Your email address").fill(email);
  await page.getByPlaceholder("Password").fill("password12");
  await page.getByRole("button", { name: "Continue with email" }).click();
  await page.waitForURL(/\/app/, { timeout: 20_000 });
  await expect(sidebarBotButton(page, /^Chief/)).toBeVisible();
  await expect(sidebarBotButton(page, /Scout/)).toBeVisible();
  await captureScreenshot(page, testInfo, "15-restored-session");
});

test("bot context menu pins, duplicates, edits, and confirms deletion", async ({
  page,
}, testInfo) => {
  const stamp = Date.now();
  await signup(page, `menu-${stamp}@ardurbot.test`, "password12", "Menu");
  await completeOnboarding(page);

  const chief = page.getByRole("button", { name: /Chief/ }).first();
  await chief.click({ button: "right" });
  await expect(page.getByRole("menu", { name: "Actions for Chief" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Bot settings" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Duplicate" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
  await captureScreenshot(page, testInfo, "16-bot-context-menu");
  await page.getByRole("menuitem", { name: "Mark as Unread" }).click();

  // Chief is the open bot, so the auto-read on window focus must not undo the manual mark.
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Mark as Read" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Mark as Read" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Pin", exact: true }).click();

  await chief.click({ button: "right" });
  await expect(page.getByRole("menuitem", { name: "Unpin", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Duplicate" }).click();
  await expect(page.getByText("Chief copy").first()).toBeVisible();
  await captureScreenshot(page, testInfo, "17-pinned-and-duplicated-bot");

  const copy = page.getByRole("button", { name: /Chief copy/ }).first();
  await copy.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await expect(page.getByRole("alertdialog", { name: "Delete Chief copy?" })).toBeVisible();
  await captureScreenshot(page, testInfo, "18-delete-confirmation");
  await page.getByRole("button", { name: "Cancel" }).click();

  await chief.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Bot settings" }).click();
  await expect(page.locator("label:has-text('Name') input")).toHaveValue("Chief");
  await captureScreenshot(page, testInfo, "19-edit-profile");
});

async function threadRunStatus(page: Page) {
  const result = await rpc<{ run?: { status?: string } | null }>(page, "threads/get", {
    botId: activeBotId(page),
  });
  return result.run?.status ?? "idle";
}

async function waitForBoxFramebuffer(page: Page) {
  await expect
    .poll(
      async () => {
        for (const frame of page.frames()) {
          if (frame === page.mainFrame()) continue;
          const canvas = frame.locator("canvas").first();
          if ((await canvas.count()) === 0) continue;
          const ready = await canvas
            .evaluate((element) => {
              const framebuffer = element as HTMLCanvasElement;
              return framebuffer.width > 0 && framebuffer.height > 0;
            })
            .catch(() => false);
          if (ready) return true;
        }
        return false;
      },
      { timeout: 60_000, message: "the Box noVNC framebuffer must be ready" },
    )
    .toBe(true);
}
