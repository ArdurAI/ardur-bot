import { describe, expect, it } from "vitest";
import { shouldRenderSpeakerContext } from "./message-context";

describe("shouldRenderSpeakerContext", () => {
  it("returns true for bot message in group thread", () => {
    expect(shouldRenderSpeakerContext({ role: "bot" } as any, [{}, {}] as any)).toBe(true);
  });
  it("returns false for user message in group thread", () => {
    expect(shouldRenderSpeakerContext({ role: "user" } as any, [{}, {}] as any)).toBe(false);
  });
  it("returns false for bot message in direct thread", () => {
    expect(shouldRenderSpeakerContext({ role: "bot" } as any, [{}] as any)).toBe(false);
  });
  it("returns false when members are missing", () => {
    expect(shouldRenderSpeakerContext({ role: "bot" } as any, undefined)).toBe(false);
  });
});
