import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
} from "@ardurbot/contracts";
import { COMMAND_OUTPUT_LIMIT, COMMAND_TRUNCATED, ProductEventSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import {
  commandSummary,
  createBoundedCommandOutput,
  exportCommandLog,
  projectCommandBlocks,
  reduceCommandMessages,
  searchCommandBlocks,
  stripCommandControls,
} from "./command-blocks.js";

describe("command projection", () => {
  it("captures command, cwd, execution identity, duration and exit with idempotent redelivery", () => {
    const event = commandEvent();
    expect(projectCommandBlocks([event, event])).toEqual([commandBlock()]);
    expect(ProductEventSchema.parse(event)).toEqual(event);
    expect(() => ProductEventSchema.parse({ ...event, payload: {} })).toThrow();
  });
  it("keeps a missing completion unknown unless the run is known live", () => {
    const event = commandEvent("command.started", {
      outcome: "running",
      exitCode: null,
      durationMs: null,
      stdout: null,
      stderr: null,
    });
    expect(projectCommandBlocks([event])[0]?.outcome).toBe("unknown");
    expect(projectCommandBlocks([event], new Set(["run-1"]))[0]?.outcome).toBe("running");
    const ended = { ...event, id: "end", seq: 4, type: "run.failed" as const, payload: {} };
    expect(projectCommandBlocks([event, ended], new Set(["run-1"]))[0]?.outcome).toBe("unknown");
  });
  it("does not invent historical command, cwd, time, output or exit fields", () => {
    const event = {
      ...commandEvent(),
      type: "agent.tool.completed" as const,
      payload: { name: "shell", executionId: "execution-1" },
    };
    const [block] = projectCommandBlocks([event]);
    expect(commandSummary(block!)).toBe(
      "Ran `Not recorded` in Not recorded · Not recorded · exit Not recorded",
    );
    expect(exportCommandLog("run-1", [block!])).toContain("stdout:\nNot recorded");
    expect(projectCommandBlocks([event, commandEvent()])).toHaveLength(1);
  });
  it("snapshots the shared thread projection and export", () => {
    expect(reduceCommandMessages([], commandEvent())).toMatchSnapshot();
    expect(
      exportCommandLog("run-1", [
        commandBlock({
          redacted: true,
          truncated: true,
          stdout: `[redacted]\n${COMMAND_TRUNCATED}`,
        }),
      ]),
    ).toMatchSnapshot();
  });
  it("searches both retained streams and errors", () => {
    const block = commandBlock({ stderr: "Warning", error: "Stopped" });
    expect(searchCommandBlocks([block], "WARN")).toEqual([block]);
    expect(searchCommandBlocks([block], "stopped")).toEqual([block]);
    expect(searchCommandBlocks([block], "absent")).toEqual([]);
  });
  it("bounds flood output in UTF-8 bytes at the collector with an explicit marker", () => {
    const output = createBoundedCommandOutput();
    for (let i = 0; i < 100; i++) output.push("😀".repeat(10000));
    expect(output.truncated).toBe(true);
    expect(output.value()).toContain(COMMAND_TRUNCATED);
    expect(new TextEncoder().encode(output.value()).length).toBeLessThanOrEqual(
      COMMAND_OUTPUT_LIMIT + 20,
    );
    expect(output.value()).not.toContain("�");
  });
  it("discards clipboard/title escape sequences, controls and bidi overrides", () => {
    const esc = String.fromCharCode(27);
    expect(
      stripCommandControls(`${esc}]52;c;ignored${String.fromCharCode(7)}${esc}[31mplain${esc}[0m`),
    ).toBe("plain");
    expect(stripCommandControls("a\u202eb\u0000c")).toBe("abc");
  });
});

function commandBlock(overrides: Partial<FixtureCommandBlock> = {}): FixtureCommandBlock {
  return {
    commandId: "command-1",
    runId: "run-1",
    attemptId: "attempt-1",
    executionId: "execution-1",
    command: "pnpm test",
    cwd: "/workspace",
    computerId: "computer-1",
    computer: "docker:container-1",
    startedAt: "2026-09-23T12:00:00.000Z",
    durationMs: 12000,
    exitCode: 0,
    outcome: "completed",
    stdout: "Tests passed.\n",
    stderr: "",
    error: null,
    redacted: false,
    truncated: false,
    replayOf: null,
    rerunDisabledReason: null,
    ...overrides,
  };
}

function commandEvent(
  type: FixtureProductEvent["type"] = "command.finished",
  overrides: Partial<FixtureCommandBlock> = {},
): FixtureProductEvent {
  return {
    id: type,
    seq: type === "command.intent" ? 1 : type === "command.started" ? 2 : 3,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    createdAt: "2026-09-23T12:00:00.000Z",
    type,
    payload: { block: commandBlock(overrides) },
  };
}
