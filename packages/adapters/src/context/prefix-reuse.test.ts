import { describe, expect, it } from "vitest";
import { estimatedTokens, measurePrefixReuse, sharedPrefixLength } from "./prefix-reuse.js";
import { groupThreadTurns } from "./prefix-reuse-fixture.js";

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
      { turn: 1, requestChars: 21, sharedChars: 0, stableChars: 9, keptHistoryChars: 0 },
      { turn: 2, requestChars: 27, sharedChars: 21, stableChars: 9, keptHistoryChars: 0 },
    ]);
  });

  it("reuses all earlier conversation of a live group thread on most turns", async () => {
    const turns = groupThreadTurns();
    const rows = await measurePrefixReuse(turns);
    const later = rows.slice(1);
    // Only compaction (turn 6) and the kept history stepping forward (turns 5 and 10) may
    // change anything before the per-turn data. A directory, brief or timestamp placed earlier
    // breaks every turn; history that slides with each message breaks all but 7 to 9.
    expect(
      later
        .filter((row, index) => row.sharedChars < rows[index]!.stableChars)
        .map((row) => row.turn),
    ).toEqual([5, 6, 10]);
    const [unchanging] = await measurePrefixReuse([{ ...turns[0]!, history: [], summary: null }]);
    for (const row of later) expect(row.sharedChars).toBeGreaterThan(unchanging!.stableChars);
  });
});
