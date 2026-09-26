import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
  ThreadMessage,
} from "@ardurbot/contracts";
import { COMMAND_OUTPUT_LIMIT, COMMAND_TRUNCATED, ProductEventSchema } from "@ardurbot/contracts";
import { describe, expect, it } from "vitest";
import type { CommandMessagesState } from "./command-blocks.js";
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
    expect(reduceCommandMessages(emptyState(), commandEvent()).messages).toMatchSnapshot();
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
      resumedEvent("call-a", "call-b", { fromCommandId: "card-a", toCommandId: "card-b" }),
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
      resumedFrom: ["card-a"],
    };
    expect(projectCommandBlocks(events)).toEqual([merged]);
    // The live thread keeps one card: the killed card's row takes the resumed call's output.
    const live = events.reduce(
      (state, event) => reduceCommandMessages(state, event),
      emptyState(),
    ).messages;
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({
      id: resumedCommandMessageId("card-b"),
      seq: 1,
      blocks: [{ kind: "command", command: merged }],
    });
  });
  it("keeps the highest fence's block when a lease-lost attempt finishes late", () => {
    const card = { commandId: "card-a", executionId: "call-a" };
    const first = { ...card, attemptId: "attempt-1", fence: 1 };
    const second = { ...card, attemptId: "attempt-2", fence: 2 };
    const finished = commandBlock({ ...second, startedAt: "2026-09-23T12:00:01.000Z" });
    const events = sequence([
      commandEvent("command.intent", { ...first, ...open("waiting", "12:00:00") }),
      commandEvent("command.started", { ...first, ...open("running", "12:00:01") }),
      commandEvent("command.started", { ...second, ...open("running", "12:00:01") }),
      commandEvent("command.finished", finished),
      // The attempt that lost its lease wakes and records its own, now stale, finish.
      commandEvent("command.finished", { ...first, outcome: "cancelled" }),
    ]);
    // List, open, export and rerun all read this projection.
    expect(projectCommandBlocks(events)).toEqual([finished]);
    const live = events.reduce(
      (state, event) => reduceCommandMessages(state, event),
      emptyState(),
    ).messages;
    expect(live).toEqual([
      expect.objectContaining({
        id: "command:card-a",
        blocks: [{ kind: "command", command: finished }],
      }),
    ]);
    // Equal fences keep the later event.
    expect(projectCommandBlocks(events.slice(0, 2), new Set(["run-1"]))[0]?.outcome).toBe(
      "running",
    );
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
  it("gives a later call that reuses a resumed call's id its own card", () => {
    // Attempt 1 is killed during `pnpm build`; attempt 2 re-issues it under a new id.
    const killed = { commandId: "card-a", executionId: "run-1:shell:0", attemptId: "attempt-1" };
    const resumed = { commandId: "card-b", executionId: "run-1:shell:1", attemptId: "attempt-2" };
    // After a pause, attempt 3 numbers its calls from zero again: `pnpm test` reuses the id.
    const reused = { commandId: "card-c", executionId: "run-1:shell:1", attemptId: "attempt-3" };
    const build = { command: "pnpm build", fence: 1 };
    const events = sequence([
      commandEvent("command.intent", { ...killed, ...build, ...open("waiting", "12:00:00") }),
      commandEvent("command.started", { ...killed, ...build, ...open("running", "12:00:01") }),
      resumedEvent(killed.executionId, resumed.executionId, {
        fromCommandId: "card-a",
        toCommandId: "card-b",
      }),
      commandEvent("command.intent", {
        ...resumed,
        ...build,
        fence: 2,
        ...open("waiting", "12:00:30"),
      }),
      commandEvent("command.finished", {
        ...resumed,
        ...build,
        fence: 2,
        startedAt: "2026-09-23T12:00:31.000Z",
        stdout: "built\n",
      }),
      commandEvent("command.intent", {
        ...reused,
        command: "pnpm test",
        fence: 3,
        ...open("waiting", "12:05:00"),
      }),
      commandEvent("command.finished", {
        ...reused,
        command: "pnpm test",
        fence: 3,
        startedAt: "2026-09-23T12:05:00.000Z",
        stdout: "tested\n",
      }),
    ]);
    expect(liveCards(events)).toEqual([
      [
        resumedCommandMessageId("card-b"),
        "pnpm build",
        "completed",
        "built\n",
        "2026-09-23T12:00:01.000Z",
      ],
      ["command:card-c", "pnpm test", "completed", "tested\n", "2026-09-23T12:05:00.000Z"],
    ]);
  });
  it("joins only the card the link names, never another card its id once had", () => {
    // `ls` finishes on the id; after a pause `pwd` reuses it and is killed, then resumes.
    const listed = { commandId: "card-x", executionId: "run-1:shell:0", command: "ls", fence: 1 };
    const killed = { commandId: "card-y", executionId: "run-1:shell:0", command: "pwd", fence: 2 };
    const resumed = { commandId: "card-z", executionId: "run-1:shell:1", command: "pwd", fence: 3 };
    const events = sequence([
      commandEvent("command.intent", { ...listed, ...open("waiting", "12:00:00") }),
      commandEvent("command.finished", { ...listed, stdout: "src\n" }),
      commandEvent("command.intent", { ...killed, ...open("waiting", "12:01:00") }),
      commandEvent("command.started", { ...killed, ...open("running", "12:01:01") }),
      resumedEvent(killed.executionId, resumed.executionId, {
        fromCommandId: "card-y",
        toCommandId: "card-z",
      }),
      commandEvent("command.intent", { ...resumed, ...open("waiting", "12:02:00") }),
      commandEvent("command.started", { ...resumed, ...open("running", "12:02:01") }),
      commandEvent("command.finished", {
        ...resumed,
        startedAt: "2026-09-23T12:02:01.000Z",
        stdout: "/workspace\n",
      }),
    ]);
    expect(liveCards(events)).toEqual([
      ["command:card-x", "ls", "completed", "src\n", "2026-09-23T12:00:00.000Z"],
      [
        resumedCommandMessageId("card-z"),
        "pwd",
        "completed",
        "/workspace\n",
        "2026-09-23T12:01:01.000Z",
      ],
    ]);
  });
  it("ignores late events from every call a chain of resumed calls took over", () => {
    const at = (commandId: string, executionId: string, fence: number) => ({
      commandId,
      executionId,
      attemptId: `attempt-${fence}`,
      fence,
    });
    const first = at("card-a", "call-a", 1);
    const second = at("card-b", "call-b", 2);
    const third = at("card-c", "call-c", 3);
    const events = sequence([
      commandEvent("command.intent", { ...first, ...open("waiting", "12:00:00") }),
      commandEvent("command.started", { ...first, ...open("running", "12:00:01") }),
      resumedEvent("call-a", "call-b", { fromCommandId: "card-a", toCommandId: "card-b" }),
      commandEvent("command.intent", { ...second, ...open("waiting", "12:00:30") }),
      commandEvent("command.started", { ...second, ...open("running", "12:00:31") }),
      resumedEvent("call-b", "call-c", { fromCommandId: "card-b", toCommandId: "card-c" }),
      commandEvent("command.intent", { ...third, ...open("waiting", "12:01:00") }),
      commandEvent("command.started", { ...third, ...open("running", "12:01:01") }),
      commandEvent("command.finished", { ...third, startedAt: "2026-09-23T12:01:01.000Z" }),
      // Both attempts that lost their lease wake and record their own, now stale, finish.
      commandEvent("command.finished", { ...first, outcome: "cancelled" }),
      commandEvent("command.finished", { ...second, outcome: "cancelled" }),
    ]);
    expect(liveCards(events)).toEqual([
      [
        resumedCommandMessageId("card-c"),
        "pnpm test",
        "completed",
        "Tests passed.\n",
        "2026-09-23T12:00:01.000Z",
      ],
    ]);
    expect(projectCommandBlocks(events)[0]?.resumedFrom).toEqual(["card-a", "card-b"]);
  });
  it("keeps a lease-lost attempt's late finish off the card a resumed call took over", () => {
    const killed = { commandId: "card-a", executionId: "call-a", attemptId: "attempt-1", fence: 1 };
    const resumed = {
      commandId: "card-b",
      executionId: "call-b",
      attemptId: "attempt-2",
      fence: 2,
    };
    const events = sequence([
      commandEvent("command.intent", { ...killed, ...open("waiting", "12:00:00") }),
      commandEvent("command.started", { ...killed, ...open("running", "12:00:01") }),
      resumedEvent("call-a", "call-b", { fromCommandId: "card-a", toCommandId: "card-b" }),
      commandEvent("command.intent", { ...resumed, ...open("waiting", "12:00:30") }),
      commandEvent("command.started", { ...resumed, ...open("running", "12:00:31") }),
      commandEvent("command.finished", { ...resumed, startedAt: "2026-09-23T12:00:31.000Z" }),
      commandEvent("command.finished", { ...killed, outcome: "cancelled" }),
    ]);
    expect(liveCards(events)).toEqual([
      [
        resumedCommandMessageId("card-b"),
        "pnpm test",
        "completed",
        "Tests passed.\n",
        "2026-09-23T12:00:01.000Z",
      ],
    ]);
  });
  it("joins a resumed call's card by its link alone, even when the killed call's card is not loaded", () => {
    // The killed call's own card is on an older page a partially loaded thread never fetched:
    // the reducer only ever sees the link and the resumed call's own events.
    const events = sequence([
      resumedEvent("call-a", "call-b", { fromCommandId: "card-a", toCommandId: "card-b" }),
      commandEvent("command.intent", {
        commandId: "card-b",
        executionId: "call-b",
        ...open("waiting", "12:00:30"),
      }),
      commandEvent("command.finished", { commandId: "card-b", executionId: "call-b" }),
    ]);
    const live = events.reduce((state, event) => reduceCommandMessages(state, event), emptyState());
    // The row carries the same id the server would use, so a later page load of the killed
    // call's already-renamed row merges into it instead of creating a second card.
    expect(live.messages.map((message) => message.id)).toEqual([resumedCommandMessageId("card-b")]);
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

function resumedEvent(
  from: string,
  to: string,
  cards: { fromCommandId: string; toCommandId: string } | Record<string, never> = {},
): FixtureProductEvent {
  return { ...commandEvent(), type: "agent.tool.resumed", payload: { from, to, ...cards } };
}

/**
 * The cards the live thread shows after every event, which must be exactly the cards the
 * projection behind list, open, export and rerun returns, one message per card.
 */
function liveCards(events: FixtureProductEvent[]) {
  const live = events.reduce(
    (state, event) => reduceCommandMessages(state, event),
    emptyState(),
  ).messages;
  const ids = live.map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
  const blocks = live.flatMap((message) =>
    message.blocks.flatMap((block) => (block.kind === "command" ? [block.command] : [])),
  );
  expect(blocks).toEqual(projectCommandBlocks(events, new Set(["run-1"])));
  return live.map((message) => {
    const [block] = message.blocks;
    const card = block?.kind === "command" ? block.command : undefined;
    return [message.id, card?.command, card?.outcome, card?.stdout, card?.startedAt];
  });
}

function sequence(events: FixtureProductEvent[]): FixtureProductEvent[] {
  return events.map((event, index) => ({ ...event, id: `event-${index}`, seq: index + 1 }));
}

function emptyState(): CommandMessagesState<ThreadMessage> {
  return { messages: [], links: [] };
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
