import { describe, expect, it } from "vitest";
import { estimatedTokens, measurePrefixReuse, sharedPrefixLength } from "./prefix-reuse.js";

describe("prompt prefix reuse", () => {
  it("counts the identical leading characters of two requests", () => {
    expect(sharedPrefixLength("tools system history", "tools system newer")).toBe(13);
    expect(sharedPrefixLength("same", "same")).toBe(4);
    expect(sharedPrefixLength("", "request")).toBe(0);
    expect(estimatedTokens(4_000)).toBe(1_000);
  });

  it("compares each assembled request with the one before it", async () => {
    const turn = { instructions: "Rules", history: [], message: "Hello" };
    expect(await measurePrefixReuse([turn, { ...turn, message: "Hello again" }])).toEqual([
      { turn: 1, requestChars: 21, sharedChars: 0 },
      { turn: 2, requestChars: 27, sharedChars: 21 },
    ]);
  });
});
