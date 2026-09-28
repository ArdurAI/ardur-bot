import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { mapMessageBlockToActivity, workRecordEntries } from "./work-record.js";

describe("mapMessageBlockToActivity", () => {
  it("maps text blocks to narration", () => {
    expect(mapMessageBlockToActivity({ kind: "text", text: "Hello" }).label).toBe("narration");
  });

  it("maps plain progress to narration, including old stored messages", () => {
    expect(mapMessageBlockToActivity({ kind: "progress", text: "On it." }).label).toBe("narration");
  });

  it("maps explicitly marked progress to reasoning", () => {
    expect(
      mapMessageBlockToActivity({ kind: "progress", text: "Thinking...", reasoning: true }).label,
    ).toBe("reasoning");
  });

  it("maps progress with activity to tool-activity", () => {
    expect(
      mapMessageBlockToActivity({ kind: "progress", text: "Using tool", activity: true }).label,
    ).toBe("tool-activity");
  });

  it("reports pending only for a live message", () => {
    const steps: MessageBlock = { kind: "steps", steps: [{ label: "Browser", count: 1 }] };
    expect(mapMessageBlockToActivity(steps).outcome).toBe("unknown");
    expect(mapMessageBlockToActivity(steps, true).outcome).toBe("pending");
    const reasoning: MessageBlock = { kind: "progress", text: "Thinking...", reasoning: true };
    expect(mapMessageBlockToActivity(reasoning).outcome).toBe("success");
    expect(mapMessageBlockToActivity(reasoning, true).outcome).toBe("pending");
  });

  it("maps steps to tool-activity", () => {
    expect(mapMessageBlockToActivity({ kind: "steps", steps: [] }).label).toBe("tool-activity");
  });

  it("maps command to tool-activity with correct outcome", () => {
    const block: MessageBlock = {
      kind: "command",
      command: {
        commandId: "1",
        runId: "1",
        attemptId: "1",
        executionId: "1",
        command: "ls",
        cwd: "/",
        computerId: "1",
        computer: "local",
        startedAt: "2026-09-28T00:00:00Z",
        durationMs: 100,
        exitCode: 0,
        outcome: "completed",
        stdout: "",
        stderr: "",
        error: "",
        redacted: false,
        truncated: false,
        replayOf: null,
        rerunDisabledReason: null,
      },
    };
    const evidence = mapMessageBlockToActivity(block);
    expect(evidence.label).toBe("tool-activity");
    expect(evidence.outcome).toBe("success");
    expect(evidence.timestamp).toBe("2026-09-28T00:00:00Z");
  });

  it("maps unhandled blocks to unavailable", () => {
    expect(mapMessageBlockToActivity({ kind: "meta", text: "meta" }).label).toBe("unavailable");
  });

  it("handles missing timestamps and unknown outcomes", () => {
    const block: MessageBlock = {
      kind: "command",
      command: {
        commandId: "1",
        runId: "1",
        attemptId: "1",
        executionId: "1",
        command: "ls",
        cwd: "/",
        computerId: "1",
        computer: "local",
        startedAt: null,
        durationMs: null,
        exitCode: null,
        outcome: "unknown",
        stdout: "",
        stderr: "",
        error: "",
        redacted: false,
        truncated: false,
        replayOf: null,
        rerunDisabledReason: null,
      },
    };
    const evidence = mapMessageBlockToActivity(block);
    expect(evidence.timestamp).toBeUndefined();
    expect(evidence.outcome).toBe("unknown");
  });

  it("handles interrupted updates", () => {
    const block: MessageBlock = {
      kind: "command",
      command: {
        commandId: "1",
        runId: "1",
        attemptId: "1",
        executionId: "1",
        command: "ls",
        cwd: "/",
        computerId: "1",
        computer: "local",
        startedAt: null,
        durationMs: null,
        exitCode: null,
        outcome: "cancelled",
        stdout: "",
        stderr: "",
        error: "",
        redacted: false,
        truncated: false,
        replayOf: null,
        rerunDisabledReason: null,
      },
    };
    const evidence = mapMessageBlockToActivity(block);
    expect(evidence.outcome).toBe("interrupted");
  });
});

describe("workRecordEntries", () => {
  it("keeps each reasoning summary exactly once, with its full text", () => {
    const summary =
      "Weighing **two** approaches before answering, with a deliberately long explanation that must never be truncated.";
    const entries = workRecordEntries([
      { kind: "progress", text: summary, reasoning: true },
      { kind: "text", text: "Here is the answer." },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.evidence.label).toBe("reasoning");
    expect(entries[0]?.evidence.title).toBe(summary);
  });

  it("keeps only tool activity and reasoning; peer and delegation blocks stay inline", () => {
    const entries = workRecordEntries([
      { kind: "progress", text: "Using browser", activity: true },
      { kind: "handoff", fromBotId: "a", toBotId: "b", text: "Go" },
      { kind: "bot_message_sent", toBotId: "b", toBotName: "Research", text: "Go" },
      { kind: "meta", text: "meta" } as MessageBlock,
      { kind: "text", text: "Reply" },
    ]);

    expect(entries.map((entry) => entry.evidence.label)).toEqual(["tool-activity"]);
  });

  it("folds interim narration into the record and leaves trailing narration out", () => {
    const entries = workRecordEntries([
      { kind: "progress", text: "Let me check." },
      { kind: "steps", steps: [{ label: "Browser", count: 1 }] },
      { kind: "progress", text: "Here is the answer." },
    ]);

    expect(entries.map((entry) => entry.evidence.label)).toEqual(["narration", "tool-activity"]);
    expect(entries[0]?.evidence.title).toBe("Let me check.");
  });

  it("keeps a plain reply with no tools out of the record", () => {
    expect(workRecordEntries([{ kind: "progress", text: "On it." }])).toEqual([]);
  });
});
