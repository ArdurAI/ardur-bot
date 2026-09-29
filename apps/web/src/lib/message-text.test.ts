import type { MessageBlock, ThreadMessage } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  copyableMessageText,
  liveMessageHasVisibleActivity,
  narrationBubbleBlocks,
  workingBotsWithoutVisibleActivity,
} from "./message-text.js";

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

  it("leaves a reasoning summary out of copied text", () => {
    expect(
      copyableMessageText(
        message([
          { kind: "progress", text: "Weighing options.", reasoning: true },
          { kind: "progress", text: "On it." },
          { kind: "text", text: "Here is the answer." },
        ]),
      ),
    ).toBe("On it.\nHere is the answer.");
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
  it("keeps a plain reply with no tools in the bubble", () => {
    const blocks: MessageBlock[] = [{ kind: "progress", text: "On it, one moment." }];
    expect(narrationBubbleBlocks(blocks)).toEqual(blocks);
  });

  it("keeps reasoning summaries out of the bubble", () => {
    const blocks: MessageBlock[] = [
      { kind: "progress", text: "Weighing two approaches.", reasoning: true },
      { kind: "text", text: "Here is the answer." },
    ];
    expect(narrationBubbleBlocks(blocks)).toEqual([{ kind: "text", text: "Here is the answer." }]);
  });

  it("folds interim narration into the record and keeps trailing narration in the bubble", () => {
    const interim: MessageBlock = { kind: "progress", text: "Let me check." };
    const trailing: MessageBlock = { kind: "progress", text: "Here is the answer." };
    const blocks: MessageBlock[] = [
      interim,
      { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
      trailing,
    ];
    expect(narrationBubbleBlocks(blocks)).toEqual([trailing]);
  });

  it("renders old stored messages without the flag as narration", () => {
    const old: MessageBlock[] = [
      { kind: "progress", text: "Checking that now." },
      { kind: "text", text: "Done." },
    ];
    expect(narrationBubbleBlocks(old)).toEqual(old);
  });

  it("folds narration flushed to text before tool activity into the record", () => {
    const flushed: MessageBlock = { kind: "text", text: "Let me check." };
    const reply: MessageBlock = { kind: "text", text: "Here is the answer." };
    const blocks: MessageBlock[] = [
      flushed,
      { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
      reply,
    ];
    expect(narrationBubbleBlocks(blocks)).toEqual([reply]);
  });

  it("keeps tool activity out of the bubble", () => {
    const blocks: MessageBlock[] = [
      { kind: "progress", text: "Using browser", activity: true },
      { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
      { kind: "text", text: "Here is the answer." },
    ];
    expect(narrationBubbleBlocks(blocks)).toEqual([{ kind: "text", text: "Here is the answer." }]);
  });
});

describe("liveMessageHasVisibleActivity", () => {
  const live = (blocks: ThreadMessage["blocks"]): ThreadMessage => ({
    id: "progress:run-1",
    threadId: "t_1",
    seq: 1,
    role: "bot",
    blocks,
    createdAt: "2026-08-29",
  });

  it("treats a tool-only live message as visible activity via its work record", () => {
    expect(
      liveMessageHasVisibleActivity(
        live([
          { kind: "progress", text: "Hermes is working.", activity: true },
          { kind: "steps", steps: [{ label: "Shell", count: 1 }] },
        ]),
      ),
    ).toBe(true);
  });

  it("treats a reasoning-only live message as visible activity", () => {
    expect(
      liveMessageHasVisibleActivity(
        live([{ kind: "progress", text: "Weighing options.", reasoning: true }]),
      ),
    ).toBe(true);
  });

  it("treats streaming reply text as visible activity", () => {
    expect(liveMessageHasVisibleActivity(live([{ kind: "progress", text: "On it" }]))).toBe(true);
  });

  it("ignores durable messages and empty live messages", () => {
    expect(
      liveMessageHasVisibleActivity(
        message([{ kind: "steps", steps: [{ label: "Shell", count: 1 }] }]),
      ),
    ).toBe(false);
    expect(liveMessageHasVisibleActivity(live([]))).toBe(false);
  });
});

describe("workingBotsWithoutVisibleActivity", () => {
  const live = (botId: string, blocks: ThreadMessage["blocks"]): ThreadMessage => ({
    id: "progress:run-1",
    threadId: "t_1",
    seq: 1,
    role: "bot",
    botId,
    blocks,
    createdAt: "2026-08-29",
  });

  it("hides only the bots whose own live message already shows activity", () => {
    const bots = [{ botId: "bot-a", name: "Ada" }, { botId: "bot-b", name: "Bea" }, { name: "Cy" }];
    expect(
      workingBotsWithoutVisibleActivity(bots, [
        live("bot-a", [{ kind: "steps", steps: [{ label: "Shell", count: 1 }] }]),
        live("bot-b", []),
      ]),
    ).toEqual([{ botId: "bot-b", name: "Bea" }, { name: "Cy" }]);
    expect(
      workingBotsWithoutVisibleActivity(bots, [
        message([{ kind: "steps", steps: [{ label: "Shell", count: 1 }] }]),
      ]),
    ).toEqual(bots);
  });
});
