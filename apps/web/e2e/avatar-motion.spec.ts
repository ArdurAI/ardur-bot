import type { Locator } from "@playwright/test";
import { expect, test } from "@playwright/test";

const runningAnimations = (target: Locator) =>
  target.evaluate((element) => element.getAnimations({ subtree: true }).length);

test("bot avatar ring stays still when reduced motion is enabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/e2e/fixtures/avatar-motion.html");

  const avatar = page.locator(".ardurbot-bot-avatar");
  await expect(avatar).toBeVisible();
  await expect(avatar).toHaveAttribute("data-phase", "thinking");
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
  expect(await runningAnimations(avatar)).toBe(0);
});

test("no seal in the gallery animates under reduced motion", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/dev/seals");
  await expect(page.getByTestId("seal-gallery")).toBeVisible();
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0);
});

test("gallery seals animate when motion is allowed, and still seals hold their pose", async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/dev/seals");
  const light = page.getByTestId("seal-gallery-light");
  for (const phase of ["starting", "thinking", "searching", "steps", "waiting", "done", "error"]) {
    const moving = light
      .locator(`[data-seal-motion="moving"] .ardurbot-bot-avatar[data-phase="${phase}"]`)
      .first();
    await expect.poll(() => runningAnimations(moving), { message: phase }).toBeGreaterThan(0);
    const still = light
      .locator(`[data-seal-motion="still"] .ardurbot-bot-avatar[data-phase="${phase}"]`)
      .first();
    expect(await runningAnimations(still), phase).toBe(0);
  }
});
