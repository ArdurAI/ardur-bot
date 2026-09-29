import { SEAL_PHASES, SEAL_SCENE_PACKS } from "@ardurbot/core";
import { expect, test } from "@playwright/test";

// The gallery is wider than the default viewport: nine phases at 112 px.
test.use({ viewport: { width: 1500, height: 1000 } });

/** Each pack draws every phase at three sizes, moving and still, plus eight pigments. */
const SEALS_PER_THEME = Object.keys(SEAL_SCENE_PACKS).length * (SEAL_PHASES.length * 6 + 8);

for (const theme of ["light", "dark"] as const) {
  test(`seal gallery captures every pack, phase, size and motion in the ${theme} theme`, async ({
    page,
  }, testInfo) => {
    await page.goto("/dev/seals");
    const panel = page.getByTestId(`seal-gallery-${theme}`);
    await expect(panel.locator(".ardurbot-bot-avatar")).toHaveCount(SEALS_PER_THEME);
    await page.evaluate(async () => {
      await document.fonts.ready;
      // Hold every moving seal at the same moment so runs can be compared.
      for (const animation of document.getAnimations()) {
        animation.pause();
        animation.currentTime = 1200;
      }
    });
    const path = testInfo.outputPath(`seal-gallery-${theme}.png`);
    await panel.screenshot({ path });
    await testInfo.attach(`seal-gallery-${theme}`, { contentType: "image/png", path });
  });
}
