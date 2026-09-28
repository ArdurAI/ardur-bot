import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

test("shared guided setup shows the services choice", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=services");
  await expect(page.getByRole("heading", { name: "Set up Ardur" })).toBeVisible();
  await expect(page.locator(".guided-step")).toHaveCount(9);
  const services = page.locator('.guided-step[aria-current="step"]');
  await expect(services).toContainText("Start Ardur services");
  await expect(services.getByText("Waiting for you", { exact: true })).toBeVisible();
  await expect(services.getByRole("checkbox", { name: "Run on startup" })).not.toBeChecked();
  await expect(page.getByRole("status")).not.toBeInViewport();
  await captureScreenshot(page, testInfo, "guided-setup-services");
  await page.emulateMedia({ reducedMotion: "reduce" });
  expect(
    await page
      .locator(".guided-setup button")
      .first()
      .evaluate((button) => getComputedStyle(button).transitionProperty),
  ).toBe("none");
  await page.evaluate(() => {
    document.documentElement.dataset.theme = "dark";
  });
  await captureScreenshot(page, testInfo, "guided-setup-services-dark");
});

test("shared guided setup keeps optional computer states distinct", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=engines");
  const engines = page.locator('.guided-step[aria-current="step"]');
  await expect(engines).toContainText("Check optional computers");
  await expect(engines.getByRole("listitem")).toHaveCount(3);
  await expect(engines.getByRole("listitem").nth(0)).toContainText("Found; connection not checked");
  await expect(engines.getByRole("listitem").nth(1)).toContainText("Connected");
  await expect(engines.getByRole("listitem").nth(2)).toContainText("Unavailable");
  await captureScreenshot(page, testInfo, "guided-setup-engines");
});

test("failed optional computer discovery still offers Skip", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=engines-failed");
  const engines = page.locator('.guided-step[aria-current="step"]');
  await expect(engines).toContainText("Optional computer discovery timed out. Retry.");
  await expect(engines.getByRole("button", { name: "Skip" })).toBeVisible();
  await captureScreenshot(page, testInfo, "guided-setup-engines-failed");
});

test("shared guided setup shows a re-check without resetting rows", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=recheck");
  const current = page.locator('.guided-step[aria-current="step"]');
  await expect(current).toContainText("Check this computer");
  await expect(current.getByText("Checking…", { exact: true })).toBeVisible();
  await expect(page.locator('.guided-step[data-status="succeeded"]')).toHaveCount(5);
  await captureScreenshot(page, testInfo, "guided-setup-recheck");
});

test("deferred model keeps first bot optional", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=model-deferred");
  await expect(page.locator('.guided-step[data-status="skipped"]')).toContainText([
    "Connect a model",
  ]);
  const bot = page.locator('.guided-step[aria-current="step"]');
  await expect(bot.getByRole("button", { name: "Do this later" })).toBeVisible();
  await expect(bot.getByRole("button", { name: "Create bot" })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "guided-setup-model-deferred");
});

test("saved model and created bot remain distinct from execution", async ({ page }, testInfo) => {
  await page.goto("/guided-setup-fixture.html?case=bot-created");
  await expect(page.getByText("Connection saved", { exact: true })).toBeVisible();
  await expect(page.locator('.guided-step[aria-current="step"]')).toContainText(
    "Create your first bot",
  );
  await expect(page.getByText("Setup complete", { exact: true })).toHaveCount(0);
  await captureScreenshot(page, testInfo, "guided-setup-bot-created");
});

for (const [scenario, heading, model, bot] of [
  ["incomplete", "Ardur is ready", "Model setup is incomplete", "First bot not created"],
  ["complete", "Setup complete", "", ""],
]) {
  test(`finish summary ${scenario}`, async ({ page }, testInfo) => {
    await page.goto(`/guided-setup-fixture.html?case=${scenario}`);
    const finish = page.locator('.guided-step[aria-current="step"]');
    await expect(finish).toContainText(heading);
    if (model) await expect(finish).toContainText(model);
    if (bot) await expect(finish).toContainText(bot);
    await expect(page.getByRole("button", { name: "Open Ardur" })).toBeVisible();
    await captureScreenshot(page, testInfo, `guided-setup-${scenario}`);
  });
}
