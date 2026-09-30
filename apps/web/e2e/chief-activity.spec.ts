import { expect, test } from "@playwright/test";
import { captureScreenshot } from "./helpers";

for (const viewport of [
  { name: "desktop", width: 1440, height: 900 },
  { name: "phone", width: 390, height: 844 },
]) {
  test(`chief activity and draft result stay concise on ${viewport.name}`, async ({
    page,
  }, info) => {
    await page.setViewportSize(viewport);
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/e2e/fixtures/chief-activity.html");
    await expect(page.getByTestId("chief-activity")).toHaveText("Connecting to Notion");
    const toggle = page.getByRole("button", { name: "Messaged Writer · Connecting to Notion" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByText("Prepare the document using approved access.")).toHaveCount(0);
    await captureScreenshot(page, info, `chief-activity-${viewport.name}`);
    await toggle.click();
    await expect(page.getByText("Prepare the document using approved access.")).toBeVisible();
    await page.goto("/e2e/fixtures/chief-activity.html?finished=1");
    await expect(page.getByTestId("chief-activity")).toHaveCount(0);
    await expect(page.getByTestId("chief-result")).toHaveText("The draft is ready. Document draft");
    await expect(page.getByRole("link", { name: "Document draft" })).toHaveAttribute(
      "href",
      "artifact:draft",
    );
    await expect(page.getByText("Done — added the document to Notion.")).toHaveCount(0);
    await page.reload();
    await expect(page.getByTestId("chief-result")).toHaveCount(1);
    await expect(page.locator("body")).toHaveJSProperty("scrollWidth", viewport.width);
    await captureScreenshot(page, info, `chief-result-${viewport.name}`);
  });
}
