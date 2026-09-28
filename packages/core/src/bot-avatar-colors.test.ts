import { describe, expect, it } from "vitest";
import { resolvePersonaColorDef } from "./bot-avatar-colors.js";

describe("persona avatar colors", () => {
  it("maps old custom colors to the nearest pigment", () => {
    expect(resolvePersonaColorDef("preview", "#EAB308").id).toBe("persimmon");
    expect(resolvePersonaColorDef("preview", "#EAB308").eyeColor).toBe("#F6F3EC");
    expect(resolvePersonaColorDef("preview", "#8B5CF6").eyeColor).toBe("#F6F3EC");
  });
});
