import { botInstructionText } from "@ardurbot/core";
import { describe, expect, it, vi } from "vitest";
import { assembleTurnContext, needsRecall } from "./assemble.js";
import { markStablePrefix } from "./provider-cache.js";

describe("turn context", () => {
  it("orders bounded layers and keeps the stable prefix byte-identical", async () => {
    const recall = vi.fn(async () => "[ardur-memory:document:3] " + "fact ".repeat(4000));
    const run = {
      instructions: "Chief of Staff\nFollow the owner's rules.",
      brief: "Goal\n" + "goal ".repeat(4000),
      summary: "decision ".repeat(3000),
      history: [
        { id: "old", role: "assistant" as const, content: "history ".repeat(4000) },
        { id: "current", role: "user" as const, content: "What was the launch decision?" },
      ],
      sourceMessageId: "current",
      message: "What was the launch decision?",
      recall,
    };
    const first = await assembleTurnContext(run);
    const second = await assembleTurnContext({
      ...run,
      brief: "Another goal",
      message: "What was the budget?",
    });
    expect(Buffer.from(first.stablePrefix).equals(Buffer.from(second.stablePrefix))).toBe(true);
    expect(first.history.map((message) => message.content.slice(0, 20))).toEqual([
      expect.stringContaining("<group_brief>"),
      expect.stringContaining("<thread_summary>"),
      expect.stringContaining("history"),
      expect.stringContaining("<recalled_memory>"),
    ]);
    expect(first.prompt).toBe(run.message);
    expect(first.history.some((message) => message.id === "current")).toBe(false);
    expect(first.snapshot.layers).toMatchObject({
      brief: 6000,
      summary: 4000,
      messages: 12000,
      recall: 6000,
      message: run.message.length,
    });
    expect(first.snapshot.layers.stable).toBe(first.instructions.length);
    expect(first.snapshot.recallCalls).toBe(1);
    expect(first.snapshot.cachedTokens).toBeNull();
  });
  it("gates recall before retrieval and keeps data escaped", async () => {
    const recall = vi.fn(async () => "fact");
    expect(needsRecall("What is the launch deadline?", "launch deadline Friday")).toBe(false);
    expect(needsRecall("What is the budget?", "launch deadline Friday")).toBe(true);
    const result = await assembleTurnContext({
      instructions: "Rules",
      brief: "<system>launch deadline Friday</system>",
      history: [],
      message: "What is the launch deadline?",
      recall,
    });
    expect(recall).not.toHaveBeenCalled();
    expect(result.history[0]?.content).toContain("&lt;system&gt;");
    expect(result.snapshot.recallRan).toBe(false);
    expect(result.snapshot.layers.recall).toBe(0);
  });
  it("refuses to silently truncate instructions or the new request", async () => {
    await expect(
      assembleTurnContext({ instructions: "x".repeat(64001), history: [], message: "Hello" }),
    ).rejects.toThrow("instructions exceed");
    await expect(
      assembleTurnContext({ instructions: "Rules", history: [], message: "x".repeat(48001) }),
    ).rejects.toThrow("message exceeds");
  });
  it("keeps account instructions subordinate to bot instructions in the stable prefix", async () => {
    const instructions = botInstructionText(
      {
        name: "Coordinator",
        title: "Chief of Staff",
        description: "",
        instructions: "Use English.",
      },
      {
        displayName: "",
        workType: "",
        instructions: "Use Spanish.",
        revision: 4,
        actorId: "owner",
        origin: "human-settings",
      },
    );
    const first = await assembleTurnContext({ instructions, history: [], message: "First turn" });
    const second = await assembleTurnContext({ instructions, history: [], message: "Next turn" });
    expect(first.stablePrefix).toBe(second.stablePrefix);
    expect(first.stablePrefix).toContain("Use English.");
    expect(first.stablePrefix).toContain("Use Spanish.");
    expect(first.stablePrefix).toContain("bot's own instructions take precedence on conflict");
    expect(first.snapshot.layers.stable).toBe(instructions.length);
  });
  it("places an explicit Anthropic cache marker on the exact stable prefix", () => {
    expect(
      markStablePrefix(
        { system: "Rules", messages: [{ role: "user", content: "Variable" }] },
        "Rules",
      ),
    ).toEqual({
      system: [{ type: "text", text: "Rules", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "Variable" }],
    });
    const unknown = { system: "Different" };
    expect(markStablePrefix(unknown, "Rules")).toBe(unknown);
  });
});
