import { SEAL_PHASES, SEAL_SCENE_PACKS } from "@ardurbot/core";
import { renderToString } from "react-dom/server";
import { expect, it } from "vitest";
import SealGallery from "./SealGallery";

it("draws every pack's phases at each size, moving and still, on both themes", () => {
  const html = renderToString(<SealGallery />);
  const packs = Object.keys(SEAL_SCENE_PACKS).length;
  const count = (pattern: RegExp) => html.match(pattern)?.length ?? 0;
  expect(count(/class="ardurbot-bot-avatar /g)).toBe(2 * packs * (SEAL_PHASES.length * 6 + 8));
  expect(count(/data-testid="seal-gallery-(?:light|dark)"/g)).toBe(2);
  expect(count(/data-seal-motion="moving"/g)).toBe(2 * packs * 3);
  expect(count(/data-seal-motion="still"/g)).toBe(2 * packs * 3);
  for (const phase of SEAL_PHASES) expect(html).toContain(`data-phase="${phase}"`);
});
