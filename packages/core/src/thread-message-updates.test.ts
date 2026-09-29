import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  takeLiveMessage,
  updateCloudAgentMessages,
  upsertAtLivePlace,
} from "./thread-message-updates.js";

const cloud = (agentId: string): MessageBlock => ({
  kind: "cloud_agent",
  agentId,
  title: "Agent",
  status: "running",
  url: "",
});

describe("shared message updates", () => {
  it("takes only the matching run and drops obsolete unscoped progress in order", () => {
    const messages = [
      { id: "first" },
      { id: "progress:legacy" },
      { id: "progress:current", runId: "current" },
      { id: "progress:other", runId: "other" },
      { id: "last" },
    ];
    const result = takeLiveMessage(messages, "progress:current");
    expect(result.previous).toBe(messages[2]);
    expect(result.remaining).toEqual([messages[0], messages[3], messages[4]]);
    expect(messages).toHaveLength(5);
  });

  it("puts the durable reply in its live draft's slot, above later arrivals", () => {
    // The owner sent "question" while the draft was on screen; the saved reply
    // fills the draft's place instead of landing below it.
    const messages = [
      { id: "earlier" },
      { id: "progress:run-1", runId: "run-1" },
      { id: "question" },
    ];
    const reply = { id: "reply-1", runId: "run-1" };
    expect(upsertAtLivePlace(messages, "progress:run-1", reply).map((m) => m.id)).toEqual([
      "earlier",
      "reply-1",
      "question",
    ]);
    // The inputs are not mutated.
    expect(messages[1]?.id).toBe("progress:run-1");
  });

  it("appends when the run has no live draft and updates by id on replay", () => {
    const messages = [{ id: "earlier" }, { id: "progress:other", runId: "other" }];
    const reply = { id: "reply-1", runId: "run-1" };
    expect(upsertAtLivePlace(messages, "progress:run-1", reply).map((m) => m.id)).toEqual([
      "earlier",
      "progress:other",
      "reply-1",
    ]);

    const updated = { id: "reply-1", runId: "run-1" };
    const withReply = [...messages, reply];
    expect(upsertAtLivePlace(withReply, "progress:run-1", updated).map((m) => m.id)).toEqual([
      "earlier",
      "progress:other",
      "reply-1",
    ]);
    expect(
      upsertAtLivePlace(withReply, "progress:run-1", updated).find((m) => m.id === "reply-1"),
    ).toBe(updated);
  });

  it("updates every matching cloud block while preserving metadata and unrelated messages", () => {
    const messages = [
      { id: "first", replyToMessageId: "reply", blocks: [cloud("agent"), cloud("other")] },
      { id: "second", replyToMessageId: "reply", blocks: [cloud("agent")] },
      {
        id: "third",
        replyToMessageId: "reply",
        blocks: [{ kind: "text", text: "unchanged" } as MessageBlock],
      },
    ];
    const result = updateCloudAgentMessages(messages, {
      messageId: "first",
      agentId: "agent",
      status: "finished",
    });
    expect(result.map((message) => message.id)).toEqual(["first", "second", "third"]);
    expect(result[0]?.replyToMessageId).toBe("reply");
    expect(result[0]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[1]?.blocks[0]).toMatchObject({ agentId: "agent", status: "finished" });
    expect(result[0]?.blocks[1]).toBe(messages[0]?.blocks[1]);
    expect(result[2]).toBe(messages[2]);
    expect(messages[0]?.blocks[0]).toMatchObject({ status: "running" });
  });
});
