import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

const viewports = [
  { name: "desktop-1440x900", width: 1440, height: 900 },
  { name: "mobile-390x844", width: 390, height: 844 },
];

for (const state of ["requested", "confirmed", "uncertain", "checking", "replacement"] as const) {
  test(`chief correction shows truthful ${state} state`, async ({ page }, testInfo) => {
    for (const viewport of viewports) {
      await page.setViewportSize(viewport);
      await page.goto(`/e2e/fixtures/coordination-line.html?stop=${state}`);
      await expect(page.getByTestId("chief-receipt")).toHaveText([
        "Got it — I’ll keep Member off this task.",
        "Got it — I’ll check this change before the next action.",
      ]);
      const label =
        state === "requested"
          ? "Told Member to stand down"
          : state === "confirmed"
            ? "Member stood down"
            : state === "uncertain"
              ? "The previous action may have finished. I’ll check before retrying."
              : state === "checking"
                ? "Checking the earlier action"
                : "Messaged Replacement";
      const activity =
        state === "requested"
          ? "Stopping Member"
          : state === "replacement"
            ? "Reading the document"
            : undefined;
      const line = page.getByTestId("chief-dispatch");
      const button = line.getByRole("button", {
        name: [label, activity].filter(Boolean).join(" · "),
        exact: true,
      });
      await expect(button).toHaveAttribute("aria-expanded", "false");
      await expect(button.locator('[aria-live="polite"]')).toHaveText(label);
      await expect(line.getByTestId("chief-activity")).toHaveCount(activity ? 1 : 0);
      if (activity) await expect(line.getByTestId("chief-activity")).toHaveText(activity);
      await expect(line).not.toContainText("Preparation request");
      await expect(line).not.toContainText(/86|87/);
      await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
      await captureScreenshot(page, testInfo, `correction-${state}-${viewport.name}`);
      await button.click();
      await expect(button).toHaveAttribute("aria-expanded", "true");
      await expect(line).toContainText("Preparation request");
    }
  });
}

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
    page.waitForURL(/\/app\/radiant$/),
    failure.getByRole("button", { name: "Fix" }).click(),
  ]);
  await expect(page).toHaveURL(/\/app\/radiant$/);
  await captureScreenshot(page, testInfo, "failure-line");
});
