import type { ParsedBotAvatar } from "@ardurbot/contracts";
import { parseBotAvatarValue } from "@ardurbot/contracts";
import { resolvePersonaColorDef, shippedBotAvatarShapePath } from "@ardurbot/core";

export type MobileBotAvatarPresentation =
  | Exclude<ParsedBotAvatar, { kind: "shape" }>
  | { kind: "shape"; color: string; shapeIndex: number; shapePath: string; eyeColor: string };

/** Resolve a stored `bots.color` value for native rendering, including shape paths. */
export function mobileBotAvatarPresentation(color: string): MobileBotAvatarPresentation {
  const parsed = parseBotAvatarValue(color);
  if (parsed.kind !== "shape") return parsed;
  return {
    ...parsed,
    shapePath: shippedBotAvatarShapePath(parsed.shapeIndex),
    eyeColor: resolvePersonaColorDef("preview", parsed.color).eyeColor,
  };
}

const SEAL_OUTLINE_WIDTH = 2;

/**
 * SVG path for the hand-cut seal edge inside an `s`×`s` viewBox.
 * CSS: border-radius: 50% 48% 52% 50% / 49% 51% 49% 51%; below 28 px the edge
 * is a true circle, per the design canvas. The path is inset by half the
 * outline stroke so a centred 2 px stroke stays fully inside the viewBox
 * while the seal's outer size is unchanged.
 */
export function sealEdgePath(s: number): string {
  const o = SEAL_OUTLINE_WIDTH / 2;
  const w = s - SEAL_OUTLINE_WIDTH;
  if (s < 28) {
    const r = w / 2;
    return [
      `M${o + r},${o}`,
      `A${r},${r},0,0,1,${o + w},${o + r}`,
      `A${r},${r},0,0,1,${o + r},${o + w}`,
      `A${r},${r},0,0,1,${o},${o + r}`,
      `A${r},${r},0,0,1,${o + r},${o}`,
      "Z",
    ].join("");
  }
  // Horizontal radii: TL=50%, TR=48%, BR=52%, BL=50%
  // Vertical radii:   TL=49%, TR=51%, BR=49%, BL=51%
  const hTL = w * 0.5;
  const vTL = w * 0.49;
  const hTR = w * 0.48;
  const vTR = w * 0.51;
  const hBR = w * 0.52;
  const vBR = w * 0.49;
  const hBL = w * 0.5;
  const vBL = w * 0.51;
  return [
    `M${o + hTL},${o}`,
    `L${o + w - hTR},${o}`,
    `A${hTR},${vTR},0,0,1,${o + w},${o + vTR}`,
    `L${o + w},${o + w - vBR}`,
    `A${hBR},${vBR},0,0,1,${o + w - hBR},${o + w}`,
    `L${o + hBL},${o + w}`,
    `A${hBL},${vBL},0,0,1,${o},${o + w - vBL}`,
    `L${o},${o + vTL}`,
    `A${hTL},${vTL},0,0,1,${o + hTL},${o}`,
    "Z",
  ].join("");
}
