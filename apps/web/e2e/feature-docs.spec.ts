import { mkdir, mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { dashboardFixture } from "./dashboard-fixture";

const captureRoot = process.env.FEATURE_DOCS_DIR
  ? Promise.resolve(process.env.FEATURE_DOCS_DIR)
  : mkdtemp(path.join(tmpdir(), "feature-docs-"));
const fixtureTime = new Date("2026-09-24T12:00:30.000Z");

test.use({
  viewport: { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  colorScheme: "light",
  locale: "en-US",
  timezoneId: "UTC",
});

async function capture(page: Page, id: string): Promise<void> {
  const directory = path.join(await captureRoot, "docs");
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${id}.png`);
  await page.screenshot({ path: file, animations: "disabled", caret: "hide", fullPage: false });
  expect(
    (await stat(file)).size,
    `${id} exceeds the 250 KB documentation budget`,
  ).toBeLessThanOrEqual(250_000);
}

async function useDashboard(page: Page) {
  const fixture = dashboardFixture();
  const base = fixture.rpc("bootstrap") as Record<string, unknown>;
  const initialBot = (base.bots as Record<string, unknown>[])[0]!;
  const bots = [initialBot];
  let answered = false;
  await page.clock.setFixedTime(fixtureTime);
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: fixture.session }));
  await page.route("**/rpc/**", async (route) => {
    const procedure = new URL(route.request().url()).pathname.slice("/rpc/".length);
    if (procedure === "threads/subscribe")
      return route.fulfill({ contentType: "text/event-stream", body: "" });
    const input = route.request().postDataJSON()?.json as Record<string, unknown> | undefined;
    let value: unknown;
    if (procedure === "models/list" || procedure === "models/credentials") value = [];
    else if (procedure === "bots/create") {
      value = { ...initialBot, ...input, id: "new-bot", name: "Planner", threadId: "new-thread" };
      bots.unshift(value as Record<string, unknown>);
    } else if (procedure === "bots/list") value = bots;
    else if (procedure === "bots/get")
      value = bots.find((bot) => bot.id === input?.botId) ?? bots[0];
    else if (procedure === "bootstrap") value = { ...base, bots };
    else if (procedure === "threads/answer") {
      answered = true;
      value = { ok: true };
    } else value = fixture.rpc(procedure, input);
    await route.fulfill({ json: { json: value } });
  });
  return {
    fixture,
    get answered() {
      return answered;
    },
  };
}

test("sign-in: open the form and recovery route", async ({ page }) => {
  await page.clock.setFixedTime(fixtureTime);
  await page.route("**/api/auth/get-session*", (route) => route.fulfill({ json: null }));
  await page.route("**/api/auth/capabilities", (route) =>
    route.fulfill({ json: { passwordReset: true, resetUrl: null } }),
  );
  await page.goto("/sign-in");
  await expect(page.getByRole("heading", { name: "Sign in to Ardur" })).toBeVisible();
  await expect(page.getByRole("textbox", { name: "Email" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue with email" })).toBeVisible();
  await capture(page, "docs-sign-in-open");
  const recovery = page.getByRole("link", { name: "Forgot password?" });
  await expect(recovery).toBeVisible();
  await recovery.click();
  await expect(page).toHaveURL(/\/forgot-password$/);
  await expect(page.getByRole("button", { name: "Send reset link" })).toBeVisible();
  await capture(page, "docs-sign-in-recovery");
});

test("onboarding: inspect the required connection", async ({ page }) => {
  const { fixture } = await useDashboard(page);
  const me = fixture.rpc("me") as Record<string, unknown>;
  await page.route("**/rpc/me", (route) =>
    route.fulfill({ json: { json: { ...me, needsModel: true } } }),
  );
  await page.route("**/rpc/models/list", (route) =>
    route.fulfill({
      json: {
        json: [
          {
            provider: "fixture",
            providerName: "Local connection",
            id: "local",
            label: "Local model",
            auth: "api-key",
            billing: "",
            reasoning: false,
            thinkingLevels: [],
          },
        ],
      },
    }),
  );
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Connect a model" })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Provider" })).toBeVisible();
  const key = page.getByLabel("API key", { exact: true });
  await expect(key).toBeVisible();
  await capture(page, "docs-onboarding-open");
  await key.fill("fixture-key");
  const next = page.getByRole("button", { name: "Continue", exact: true });
  await expect(next).toBeEnabled();
  await capture(page, "docs-onboarding-connect");
});

test("bots-create: select a computer mode before creating", async ({ page }) => {
  await useDashboard(page);
  await page.goto("/app/bot");
  const create = page.getByTestId("create-menu-trigger");
  await expect(create).toBeVisible();
  await create.click();
  const newBot = page.getByTestId("create-new-bot");
  await expect(newBot).toBeVisible();
  await capture(page, "docs-bots-create-open");
  await newBot.click();
  const form = page.getByTestId("create-bot-form");
  await expect(form).toBeVisible();
  await expect(form.getByRole("textbox", { name: "Name" })).toBeVisible();
  await expect(form.getByRole("button", { name: "Private" })).toBeVisible();
  await capture(page, "docs-bots-create-form");
  await form.getByRole("textbox", { name: "Name" }).fill("Planner");
  const privateMode = form.getByRole("button", { name: "Private" });
  await expect(privateMode).toBeVisible();
  await privateMode.click();
  await expect(privateMode).toHaveAttribute("aria-pressed", "true");
  await capture(page, "docs-bots-create-private");
});

test("models: open settings and inspect the empty catalog", async ({ page }) => {
  await useDashboard(page);
  await page.goto("/app/bot");
  const settings = page
    .locator("header.app-drag")
    .getByRole("button", { name: "Settings", exact: true });
  await expect(settings).toBeVisible();
  await settings.click();
  const panel = page.getByTestId("user-settings");
  const models = panel.getByTestId("settings-nav-models");
  await expect(models).toBeVisible();
  await capture(page, "docs-models-open");
  await models.click();
  await expect(panel.getByRole("heading", { name: "Models", exact: true })).toBeVisible();
  await expect(panel.getByText("No model catalog is available.")).toBeVisible();
  await capture(page, "docs-models-empty");
});

test("chat-approvals: inspect and deny a pending action", async ({ page }) => {
  const state = await useDashboard(page);
  await page.goto("/app/bot");
  const deny = page.getByRole("button", { name: "Deny", exact: true });
  await expect(page.getByRole("button", { name: "Allow once", exact: true })).toBeVisible();
  await expect(deny).toBeVisible();
  await capture(page, "docs-chat-approvals-pending");
  await deny.click();
  await expect.poll(() => state.answered).toBe(true);
  await expect(deny).toBeHidden();
  await capture(page, "docs-chat-approvals-denied");
});
