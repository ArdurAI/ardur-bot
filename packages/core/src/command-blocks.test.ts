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
  resumedCommandMessageId,
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
  it("joins a resumed call's card to the card its killed call published", () => {
    const killed = { commandId: "card-a", executionId: "call-a", attemptId: "attempt-1" };
    const resumed = { commandId: "card-b", executionId: "call-b", attemptId: "attempt-2" };
    const events = sequence([
      commandEvent("command.intent", { ...killed, ...open("waiting", "12:00:00") }),
      commandEvent("command.started", { ...killed, ...open("running", "12:00:01") }),
      resumedEvent("call-a", "call-b"),
      commandEvent("command.intent", { ...resumed, ...open("waiting", "12:00:30") }),
      commandEvent("command.started", { ...resumed, ...open("running", "12:00:31") }),
      commandEvent("command.finished", {
        ...resumed,
        startedAt: "2026-09-23T12:00:31.000Z",
        durationMs: 2_000,
        stdout: "built\n",
      }),
    ]);
    const merged = {
      ...commandBlock({ ...resumed, stdout: "built\n" }),
      startedAt: "2026-09-23T12:00:01.000Z",
      durationMs: 32_000,
    };
    expect(projectCommandBlocks(events)).toEqual([merged]);
    // The live thread keeps one card: the killed card's row takes the resumed call's output.
    const live = events.reduce<ReturnType<typeof reduceCommandMessages>>(
      (messages, event) => reduceCommandMessages(messages, event),
      [],
    );
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: resumedCommandMessageId("run-1", "call-b"),
      seq: 1,
      blocks: [{ kind: "command", command: merged }],
    });
  });
  it("keeps a killed card unknown when no call resumed it", () => {
    const events = sequence([
      commandEvent("command.started", {
        commandId: "card-a",
        executionId: "call-a",
        ...open("running", "12:00:01"),
      }),
      commandEvent("command.finished", { commandId: "card-b", executionId: "call-b" }),
    ]);
    expect(projectCommandBlocks(events).map((block) => [block.executionId, block.outcome])).toEqual(
      [
        ["call-a", "unknown"],
        ["call-b", "completed"],
      ],
    );
  });
  it("joins a resumed call to a killed call that never published a card", () => {
    const events = sequence([
      {
        ...commandEvent(),
        type: "agent.tool.called" as const,
        payload: { name: "shell", executionId: "call-a" },
      },
      resumedEvent("call-a", "call-b"),
      commandEvent("command.finished", { commandId: "card-b", executionId: "call-b" }),
    ]);
    expect(projectCommandBlocks(events)).toEqual([
      commandBlock({ commandId: "card-b", executionId: "call-b" }),
    ]);
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

function open(outcome: "waiting" | "running", time: string): Partial<FixtureCommandBlock> {
  return {
    outcome,
    startedAt: `2026-09-23T${time}.000Z`,
    durationMs: null,
    exitCode: null,
    stdout: null,
    stderr: null,
  };
}

function resumedEvent(from: string, to: string): FixtureProductEvent {
  return { ...commandEvent(), type: "agent.tool.resumed", payload: { from, to } };
}

function sequence(events: FixtureProductEvent[]): FixtureProductEvent[] {
  return events.map((event, index) => ({ ...event, id: `event-${index}`, seq: index + 1 }));
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
