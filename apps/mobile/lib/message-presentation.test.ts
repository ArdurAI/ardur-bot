import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  hasVisibleMessagePresentation,
  isCenteredAgentEvent,
  liveReplyTextStreaming,
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
    expect(
      hasVisibleMessagePresentation([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
      ]),
    ).toBe(false);
  });

  it("hides marked activity without treating Using narration as a tool", () => {
    const activity = { kind: "progress", text: "Using browser", activity: true } as const;
    const narration = { kind: "progress", text: "Using browser is optional." } as const;

    expect(messagePresentationSegments([activity, narration])).toEqual([
      { kind: "content", blocks: [narration] },
    ]);

    const mixed: Extract<MessageBlock, { kind: "progress" }> = {
      kind: "progress",
      text: "Let me check",
      pendingToolNames: ["browser"],
    };
    expect(messagePresentationSegments([mixed])).toEqual([{ kind: "content", blocks: [mixed] }]);
  });

  it("keeps only response content around tool activity", () => {
    const tool: Extract<MessageBlock, { kind: "steps" }> = {
      kind: "steps",
      steps: [{ label: "Read file", count: 1 }],
    };

    expect(
      messagePresentationSegments([
        { kind: "text", text: "Checking." },
        tool,
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([
      {
        kind: "content",
        blocks: [
          { kind: "text", text: "Checking." },
          { kind: "text", text: "Done." },
        ],
      },
    ]);

    expect(
      messagePresentationSegments([
        { kind: "steps", steps: [{ label: "Message bot", count: 1 }] },
        { kind: "text", text: "Done." },
      ]),
    ).toEqual([{ kind: "content", blocks: [{ kind: "text", text: "Done." }] }]);
  });

  it("shows the reply cursor only while the draft's tail text is still growing", () => {
    // Text is streaming in: cursor on.
    expect(
      liveReplyTextStreaming([
        { kind: "progress", text: "Chief's summary", streaming: true } as MessageBlock,
      ]),
    ).toBe(true);

    // Text stopped while the run works on commands: cursor off, even though the
    // draft is still live.
    expect(
      liveReplyTextStreaming([
        {
          kind: "progress",
          text: "Chief's summary",
          pendingToolNames: ["run_command"],
        } as MessageBlock,
      ]),
    ).toBe(false);
    expect(
      liveReplyTextStreaming([
        { kind: "progress", text: "Running gh pr list", activity: true } as MessageBlock,
      ]),
    ).toBe(false);

    // The run ended: the durable message carries plain text, never a cursor.
    expect(liveReplyTextStreaming([{ kind: "text", text: "Chief's summary" }])).toBe(false);
    expect(liveReplyTextStreaming([])).toBe(false);
  });
});
