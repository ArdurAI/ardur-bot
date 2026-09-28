import type { MessageBlock, ThreadMessage } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { copyableMessageText, narrationBubbleBlocks } from "./message-text.js";

function message(blocks: ThreadMessage["blocks"]): ThreadMessage {
  return { id: "m_1", threadId: "t_1", seq: 1, role: "bot", blocks, createdAt: "2026-08-29" };
}

describe("copyableMessageText", () => {
  it("joins text, progress, and ask blocks without chrome", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "text", text: "first" },
          { kind: "progress", text: "working" },
          { kind: "ask", text: "question?" },
        ]),
      ),
    ).toBe("first\nworking\nquestion?");
  });

  it("includes channel messages with their chat attribution", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "RCS",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "dinner at 7?",
            hop: 0,
          },
        ]),
      ),
    ).toBe("RCS · Alice: dinner at 7?");
  });

  it("falls back to the provider label for unknown transport values", () => {
    expect(
      copyableMessageText(
        message([
          {
            kind: "channel_message",
            provider: "sendblue",
            transport: "email",
            channelId: "ch-1",
            fromAddress: "+15551234567",
            fromLabel: "Alice",
            text: "hello",
          },
        ]),
      ),
    ).toBe("iMessage · Alice: hello");
  });
});

describe("narrationBubbleBlocks", () => {
  it("keeps reasoning summaries and tool activity out of the reply bubble", () => {
    const blocks: MessageBlock[] = [
      { kind: "text", text: "Here is the answer." },
      { kind: "progress", text: "Weighing two approaches before answering." },
      { kind: "progress", text: "Using browser", activity: true },
      { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
    ];

    expect(narrationBubbleBlocks(blocks)).toEqual([{ kind: "text", text: "Here is the answer." }]);
  });
});
