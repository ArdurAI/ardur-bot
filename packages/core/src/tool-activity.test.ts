import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { isReasoningSummaryBlock, isToolActivityBlock } from "./tool-activity.js";

describe("tool activity", () => {
  it.each<MessageBlock>([
    { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
    { kind: "progress", text: "Using browser", activity: true },
    { kind: "progress", text: "Using brex: list_expenses", activity: true },
  ])("recognizes $kind activity", (block) => {
    expect(isToolActivityBlock(block)).toBe(true);
  });

  it("keeps assistant narration separate from tool activity", () => {
    expect(isToolActivityBlock({ kind: "progress", text: "I’m checking that now." })).toBe(false);
    expect(isToolActivityBlock({ kind: "progress", text: "Using browser" })).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Let me check",
        pendingToolNames: ["browser"],
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({ kind: "progress", text: "Using the search results, I found it." }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using the search results, I found…",
      }),
    ).toBe(false);
    expect(
      isToolActivityBlock({
        kind: "progress",
        text: "Using these notes, here is a summary.",
      }),
    ).toBe(false);
    expect(isToolActivityBlock({ kind: "text", text: "Done." })).toBe(false);
  });

  it("treats progress beats without activity as reasoning summaries", () => {
    expect(isReasoningSummaryBlock({ kind: "progress", text: "Thinking…" })).toBe(true);
    expect(
      isReasoningSummaryBlock({
        kind: "progress",
        text: "Let me check",
        pendingToolNames: ["browser"],
      }),
    ).toBe(true);
    expect(
      isReasoningSummaryBlock({ kind: "progress", text: "Using browser", activity: true }),
    ).toBe(false);
    expect(isReasoningSummaryBlock({ kind: "text", text: "Done." })).toBe(false);
    expect(isReasoningSummaryBlock({ kind: "steps", steps: [] })).toBe(false);
  });
});
