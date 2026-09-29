import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  isInterimNarrationAt,
  isReasoningSummaryBlock,
  isToolActivityBlock,
} from "./tool-activity.js";

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

  it("treats only explicitly marked progress as reasoning summaries", () => {
    expect(isReasoningSummaryBlock({ kind: "progress", text: "Thinking…", reasoning: true })).toBe(
      true,
    );
    expect(isReasoningSummaryBlock({ kind: "progress", text: "On it." })).toBe(false);
    expect(
      isReasoningSummaryBlock({ kind: "progress", text: "Using browser", activity: true }),
    ).toBe(false);
    expect(isReasoningSummaryBlock({ kind: "text", text: "Done." })).toBe(false);
    expect(isReasoningSummaryBlock({ kind: "steps", steps: [] })).toBe(false);
  });

  it("folds narration interrupted by later tool activity into the record", () => {
    const interim: MessageBlock = { kind: "progress", text: "Let me check." };
    const activity: MessageBlock = { kind: "progress", text: "Using browser", activity: true };
    const trailing: MessageBlock = { kind: "progress", text: "Here is the answer." };
    const blocks = [interim, activity, trailing];

    expect(isInterimNarrationAt(blocks, 0)).toBe(true);
    expect(isInterimNarrationAt(blocks, 2)).toBe(false);
    // Reasoning summaries and activity beats are never interim narration.
    expect(
      isInterimNarrationAt([{ kind: "progress", text: "Thinking…", reasoning: true }, activity], 0),
    ).toBe(false);
    expect(isInterimNarrationAt([activity, trailing], 0)).toBe(false);
    // A reply with no tools at all is never interim.
    expect(isInterimNarrationAt([trailing], 0)).toBe(false);
  });

  it("folds text flushed before a tool call into the record", () => {
    const flushed: MessageBlock = { kind: "text", text: "Let me check." };
    const steps: MessageBlock = { kind: "steps", steps: [{ label: "Shell", count: 1 }] };
    const reply: MessageBlock = { kind: "text", text: "Here is the answer." };
    const blocks = [flushed, steps, reply];

    expect(isInterimNarrationAt(blocks, 0)).toBe(true);
    expect(isInterimNarrationAt(blocks, 2)).toBe(false);
    expect(isInterimNarrationAt([flushed], 0)).toBe(false);
  });
});
