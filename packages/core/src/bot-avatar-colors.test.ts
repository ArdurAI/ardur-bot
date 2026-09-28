import { BOT_COLORS } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { GROK_BOT_COLORS, resolvePersonaColorDef } from "./bot-avatar-colors.js";

describe("persona avatar colors", () => {
  it("maps old custom colors to the nearest pigment", () => {
    expect(resolvePersonaColorDef("preview", "#EAB308").id).toBe("persimmon");
    expect(resolvePersonaColorDef("preview", "#EAB308").eyeColor).toBe("#F6F3EC");
    expect(resolvePersonaColorDef("preview", "#8B5CF6").eyeColor).toBe("#F6F3EC");
  });

  it("keeps the bot creation palette identical to the displayed pigments", () => {
    // New bots are assigned BOT_COLORS round-robin; if these drift apart the
    // stored color snaps to a nearest pigment and Avatar Studio cannot mark it.
    expect([...BOT_COLORS]).toEqual([...GROK_BOT_COLORS]);
  });

  it("maps every legacy creation color to a distinct pigment", () => {
    // Bots created before the pigment palette shipped carry these hexes; the
    // 1:1 table keeps the spread they had instead of collapsing onto 4 of 8.
    const legacy = ["#3EC5A8", "#F5A03C", "#6A6BF5", "#9B5CF6", "#3B82F6", "#F2622A", "#D9508A"];
    const ids = legacy.map((hex) => resolvePersonaColorDef("bot", hex).id);
    expect(ids).toEqual(["teal", "ochre", "indigo", "plum", "slate", "persimmon", "bengara"]);
    expect(new Set(ids).size).toBe(legacy.length);
  });
});
