import type { ThreadMessage } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { copyableMessageText, replyMarkdownProps } from "./message-text.js";

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

describe("replyMarkdownProps", () => {
  it("shows the cursor only on reply text that is still streaming", () => {
    expect(
      replyMarkdownProps({ kind: "progress", text: "Chief's summary", streaming: true }),
    ).toEqual({ streaming: true, cursor: true });
    // The text paused while the run works: the streaming layout stays, the cursor goes.
    expect(replyMarkdownProps({ kind: "progress", text: "Chief's summary" })).toEqual({
      streaming: true,
      cursor: false,
    });
    // Tool activity never carries the reply cursor.
    expect(
      replyMarkdownProps({
        kind: "progress",
        text: "Running gh pr list",
        activity: true,
        streaming: true,
      }),
    ).toEqual({ streaming: true, cursor: false });
    // A saved reply is plain text.
    expect(replyMarkdownProps({ kind: "text", text: "Chief's summary" })).toEqual({
      streaming: false,
      cursor: false,
    });
  });
});
