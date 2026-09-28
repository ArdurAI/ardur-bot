import type { MessageBlock } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import { mapMessageBlockToActivity, workRecordEntries } from "./work-record.js";

describe("mapMessageBlockToActivity", () => {
  it("maps text blocks to narration", () => {
    expect(mapMessageBlockToActivity({ kind: "text", text: "Hello" }).label).toBe("narration");
  });

  it("maps progress without activity to reasoning", () => {
    expect(mapMessageBlockToActivity({ kind: "progress", text: "Thinking..." }).label).toBe(
      "reasoning",
    );
  });

  it("maps progress with activity to tool-activity", () => {
    expect(
      mapMessageBlockToActivity({ kind: "progress", text: "Using tool", activity: true }).label,
    ).toBe("tool-activity");
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
      { kind: "progress", text: summary },
      { kind: "text", text: "Here is the answer." },
    ]);

    expect(entries).toHaveLength(1);
    expect(entries[0]?.evidence.label).toBe("reasoning");
    expect(entries[0]?.evidence.title).toBe(summary);
  });

  it("excludes narration and keeps tool activity", () => {
    const entries = workRecordEntries([
      { kind: "text", text: "Reply" },
      { kind: "progress", text: "Using browser", activity: true },
      { kind: "meta", text: "meta" } as MessageBlock,
    ]);

    expect(entries.map((entry) => entry.evidence.label)).toEqual(["tool-activity"]);
  });
});
