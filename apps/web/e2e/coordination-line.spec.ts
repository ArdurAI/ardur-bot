import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

test("group ask shows the answers with one collapsed coordination line", async ({
  page,
}, testInfo) => {
  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/e2e/fixtures/coordination-line.html");
    await expect(page.getByTestId("message-user-bubble")).toHaveText(
      "make every say hello to each other",
    );
    // Three member replies still render as ordinary messages.
    await expect(page.getByTestId("message-bot-bubble")).toHaveCount(3);
    // The coordination round is one collapsed line with counts, not chat text.
    const line = page.getByTestId("coordination-line");
    await expect(line).toBeVisible();
    await expect(line.locator('[data-testid="coordination-line-summary"]')).toHaveText(
      "Asked 3 bots · 3 answered",
    );
    await expect(page.getByTestId("coordination-request")).toHaveCount(0);
    // Expanding shows the request and each member's outcome.
    await line.getByRole("button").click();
    await expect(page.getByTestId("coordination-request")).toHaveText(
      "Say hello to your teammates in this thread.",
    );
    await expect(page.getByTestId("coordination-member")).toHaveCount(3);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, testInfo, `expanded-${viewport.name}`);
    // Collapsing again leaves just the one line.
    await line.getByRole("button").click();
    await expect(page.getByTestId("coordination-request")).toHaveCount(0);
    await expect(page.getByTestId("coordination-line-summary")).toHaveCount(1);
  }
});

test("a member that could not answer shows one plain line with a fix link", async ({
  page,
}, testInfo) => {
  await page.setViewportSize(viewports[0]);
  await page.goto("/e2e/fixtures/coordination-line.html?failed=1");
  const failure = page.getByTestId("coordination-failure");
  await expect(failure).toHaveText("Radiant couldn't answer: its model account needs attentionFix");
  await expect(page.getByTestId("coordination-line-summary")).toHaveText(
    "Asked 3 bots · 2 answered",
  );
  // The fix link goes to the failed member's own chat.
  await Promise.all([
    page.waitForNavigation(),
    failure.getByRole("button", { name: "Fix" }).click(),
  ]);
  await expect(page).toHaveURL(/\/app\/radiant$/);
  await captureScreenshot(page, testInfo, "failure-line");
});
