import { expect, test } from "@playwright/test";

test("bot avatar ring stays still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const avatar = page.locator(".ardurbot-bot-avatar");
  await expect(avatar).toBeVisible();
  const ring = avatar.locator("svg").filter({ has: page.locator("circle") });
  await expect(ring).toBeVisible();
  const snapshot = () =>
    ring.evaluate((el: SVGElement) => ({
      animationName: getComputedStyle(el).animationName,
      transform: getComputedStyle(el).transform,
    }));
  const first = await snapshot();
  await page.waitForTimeout(300);
  const second = await snapshot();

  expect(first.animationName).toBe("none");
  expect(second).toEqual(first);
});
