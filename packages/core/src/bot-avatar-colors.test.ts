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
});
