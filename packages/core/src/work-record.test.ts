import { describe, expect, it } from "vitest";
import { mapMessageBlockToActivity } from "./work-record.js";
import type { MessageBlock } from "@ardurbot/contracts";

describe("mapMessageBlockToActivity", () => {
  it("maps text blocks to narration", () => {
    expect(mapMessageBlockToActivity({ kind: "text", text: "Hello" }).label).toBe("narration");
  });

  it("maps progress without activity to narration", () => {
    expect(mapMessageBlockToActivity({ kind: "progress", text: "Thinking..." }).label).toBe("narration");
  });

  it("maps progress with activity to tool-activity", () => {
    expect(mapMessageBlockToActivity({ kind: "progress", text: "Using tool", activity: true }).label).toBe("tool-activity");
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
        rerunDisabledReason: null
      }
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
        rerunDisabledReason: null
      }
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
        rerunDisabledReason: null
      }
    };
    const evidence = mapMessageBlockToActivity(block);
    expect(evidence.outcome).toBe("interrupted");
  });
});
