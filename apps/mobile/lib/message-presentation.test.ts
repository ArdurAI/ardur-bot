import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  messagePresentationSegments,
} from "./message-presentation";

describe("mobile message presentation", () => {
  it("centers handoffs, inter-agent messages, and channel mirrors", () => {
    const blocks = [
      { kind: "handoff", fromBotId: "a", toBotId: "b", text: "Go" },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
      {
        kind: "bot_message_received",
        fromBotId: "b",
        fromBotName: "Research",
        text: "Done",
      },
      {
        kind: "channel_message",
        provider: "sendblue",
        channelId: "ch-1",
        fromAddress: "+15551234567",
        fromLabel: "Alex",
        text: "Hello from the group",
      },
    ] as MessageBlock[];

    for (const block of blocks) expect(isCenteredAgentEvent([block])).toBe(true);
    expect(isCenteredAgentEvent([{ kind: "text", text: "Hello" }])).toBe(false);
  });

  it("hides completed tool activity", () => {
    const blocks = [
      {
        kind: "steps",
        steps: [
          { label: "Read file", count: 1 },
          { label: "Message bot", count: 1 },
        ],
      },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
    ] as MessageBlock[];

    expect(messagePresentationSegments(blocks)).toEqual([
      {
        kind: "content",
        blocks: [{ kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" }],
      },
    ]);
  });

  it("keeps a plain reply with no tools in the bubble", () => {
    const reply = { kind: "progress", text: "On it, one moment." } as const;
    expect(messagePresentationSegments([reply])).toEqual([{ kind: "content", blocks: [reply] }]);
  });

  it("moves only marked reasoning summaries to the record", () => {
    const activity = { kind: "progress", text: "Using browser", activity: true } as const;
    const reasoning = {
      kind: "progress",
      text: "Using browser is optional.",
      reasoning: true,
    } as const;

    expect(messagePresentationSegments([activity, reasoning])).toEqual([]);
    // A reasoning-only message stays visible: the record renders it.
    expect(hasVisibleMessagePresentation([reasoning])).toBe(true);

    const mixed: Extract<MessageBlock, { kind: "progress" }> = {
      kind: "progress",
      text: "Let me check",
      pendingToolNames: ["browser"],
    };
    expect(messagePresentationSegments([mixed])).toEqual([{ kind: "content", blocks: [mixed] }]);
  });

  it("folds interim narration into the record and keeps trailing narration in the bubble", () => {
    const interim = { kind: "progress", text: "Let me check." } as const;
    const steps = {
      kind: "steps",
      steps: [{ label: "Browser", count: 1 }],
    } satisfies MessageBlock;
    const trailing = { kind: "progress", text: "Here is the answer." } as const;

    expect(messagePresentationSegments([interim, steps, trailing])).toEqual([
      { kind: "content", blocks: [trailing] },
    ]);
  });

  it("folds narration flushed to text before tool activity into the record", () => {
    const flushed = { kind: "text", text: "Let me check." } as const;
    const steps = {
      kind: "steps",
      steps: [{ label: "Browser", count: 1 }],
    } satisfies MessageBlock;
    const reply = { kind: "text", text: "Here is the answer." } as const;

    expect(messagePresentationSegments([flushed, steps, reply])).toEqual([
      { kind: "content", blocks: [reply] },
    ]);
  });

  it("renders old stored messages without the flag as narration", () => {
    const old = [
      { kind: "progress", text: "Checking that now." },
      { kind: "text", text: "Done." },
    ] as MessageBlock[];
    expect(messagePresentationSegments(old)).toEqual([{ kind: "content", blocks: old }]);
  });

  it("keeps tool-only messages visible for the record", () => {
    const stepsOnly = [
      { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
    ] as MessageBlock[];
    expect(messagePresentationSegments(stepsOnly)).toEqual([]);
    expect(hasVisibleMessagePresentation(stepsOnly)).toBe(true);
  });

  it("keeps only the trailing response content around tool activity", () => {
    const tool: Extract<MessageBlock, { kind: "steps" }> = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    };

    // The interim note folds into the work record; the answer stays in the bubble.
    expect(
      messagePresentationSegments([
        { kind: "text", text: "Checking." },
        tool,
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([
      {
        kind: "content",
        blocks: [{ kind: "text", text: "Done." }],
      },
    ]);

    expect(
      messagePresentationSegments([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([{ kind: "content", blocks: [{ kind: "text", text: "Done." }] }]);
  });
});
