import { darkTokens, botColors as sharedBotColors } from "@ardurbot/ui-tokens";
import { describe, expect, it } from "vitest";
import { botColors, tokens } from "./theme.js";

describe("mobile theme tokens", () => {
  it("exposes the shared product palette used by custom surfaces", () => {
    expect(tokens).toBe(darkTokens);
  });

  it("re-exports botColors for identity accents", () => {
    expect(botColors.length).toBeGreaterThan(0);
    expect(botColors).toBe(sharedBotColors);
  });
});
