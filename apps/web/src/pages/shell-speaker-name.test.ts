import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { darkTokens, lightTokens } from "@ardurbot/ui-tokens";
import { describe, expect, it } from "vitest";

function luminance(colour: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = Number.parseInt(colour.slice(start, start + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(first: string, second: string): number {
  const a = luminance(first);
  const b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("group-chat speaker name", () => {
  it("uses the foreground token, which meets WCAG AA on the page background", () => {
    // Dark mode was the complaint: pigment hexes like indigo #2F4A7A are near
    // invisible on the dark background, so the name now uses text-foreground.
    expect(contrast(darkTokens.foreground, darkTokens.background)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(lightTokens.foreground, lightTokens.background)).toBeGreaterThanOrEqual(4.5);
  });

  it("renders the speaker header without pigment inline colors", () => {
    const source = readFileSync(fileURLToPath(new URL("./Shell.tsx", import.meta.url)), "utf8");
    expect(source).not.toContain("speakerColorDef");
    expect(source).toContain("tracking-tight text-foreground");
  });
});
