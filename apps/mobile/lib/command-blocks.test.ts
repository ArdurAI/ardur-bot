import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
  ThreadMessage,
} from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api.js";
import { applyMobileThreadEvent, isMobileThreadSnapshotEvent } from "./api.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));
// Command projection runs without the native device bridge in the Node test host.
vi.mock("./dispatch", () => ({
  dispatchClient: { loadHome: vi.fn(async () => null) },
  deviceRpc: vi.fn(),
}));

describe("native command projection", () => {
  it("matches the shared command projection and is idempotent", () => {
    const initial: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 0,
      messages: [],
      olderCursor: null,
      run: null,
    };
    const event = commandEvent();
    const next = applyMobileThreadEvent(initial, event);
    expect(next?.messages).toMatchSnapshot();
    expect(applyMobileThreadEvent(next, event)?.messages).toEqual(next?.messages);
  });
  it("marks an unfinished native block unknown when the run ends", () => {
    const initial: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 0,
      messages: [],
      olderCursor: null,
      run: null,
    };
    const next = applyMobileThreadEvent(
      initial,
      commandEvent("command.started", { outcome: "running", exitCode: null, durationMs: null }),
    );
    const ended = applyMobileThreadEvent(next, {
      ...commandEvent(),
      type: "run.failed",
      payload: {},
    });
    expect(ended?.messages[0]?.blocks[0]).toMatchObject({ command: { outcome: "unknown" } });
  });
  it("passes command and resumed events through the live snapshot filter, as web does", () => {
    expect(isMobileThreadSnapshotEvent(commandEvent("command.intent"))).toBe(true);
    expect(isMobileThreadSnapshotEvent(commandEvent("command.started"))).toBe(true);
    expect(isMobileThreadSnapshotEvent(commandEvent("command.finished"))).toBe(true);
    expect(isMobileThreadSnapshotEvent(resumedEvent("execution-1", "execution-2", cards))).toBe(
      true,
    );
  });
  it("joins a resumed call into the killed call's card while the stream is live", () => {
    const initial: MobileSnapshot = {
      threadId: "thread-1",
      cursor: 0,
      messages: [],
      olderCursor: null,
      run: null,
    };
    const started = applyMobileThreadEvent(
      initial,
      commandEvent("command.started", { outcome: "running", exitCode: null, durationMs: null }),
    );
    const event = resumedEvent("execution-1", "execution-2", cards);
    // The live stream, like `thread.tsx`, only applies events the snapshot filter admits.
    const next = isMobileThreadSnapshotEvent(event)
      ? applyMobileThreadEvent(started, event)
      : started;
    expect(next?.messages[0]?.id).toBe("command:resumed:command-2");
  });
  it("keeps the recovering attempt's finish when a lease-lost attempt finishes late", () => {
    const first = { attemptId: "attempt-1", fence: 1 };
    const second = { attemptId: "attempt-2", fence: 2 };
    const running = { outcome: "running" as const, exitCode: null, durationMs: null };
    const events = [
      commandEvent("command.intent", { ...first, ...running, outcome: "waiting" }),
      commandEvent("command.started", { ...first, ...running }),
      commandEvent("command.started", { ...second, ...running }),
      commandEvent("command.finished", second),
      commandEvent("command.finished", { ...first, outcome: "cancelled" }),
    ].map((event, index) => ({ ...event, id: `event-${index}`, seq: index + 1 }));
    const live = events.reduce<MobileSnapshot | null>(
      (current, event) =>
        isMobileThreadSnapshotEvent(event) ? applyMobileThreadEvent(current, event) : current,
      { threadId: "thread-1", cursor: 0, messages: [], olderCursor: null, run: null },
    );
    expect(live?.messages).toEqual([
      expect.objectContaining({ blocks: [{ kind: "command", command: commandBlock(second) }] }),
    ]);
  });
  it("keeps every card when resumed calls reuse ids and a resumed-away call finishes late", () => {
    const live = resumedCallScenario().reduce<MobileSnapshot | null>(
      (current, event) =>
        isMobileThreadSnapshotEvent(event) ? applyMobileThreadEvent(current, event) : current,
      { threadId: "thread-1", cursor: 0, messages: [], olderCursor: null, run: null },
    );
    expect(shownCards(live?.messages as ThreadMessage[] | undefined)).toEqual(RESUMED_CALL_CARDS);
  });
});

const cards = { fromCommandId: "command-1", toCommandId: "command-2" };

/**
 * One run through all three ways a resumed call's card was lost: `ls` finishes on an id that a
 * later `pnpm build` reuses and is killed on; the build resumes under a new id; the killed
 * attempt finishes late; and after a pause `pnpm test` reuses the resumed call's id.
 */
function resumedCallScenario(): FixtureProductEvent[] {
  const listed = { commandId: "card-x", executionId: "shell:0", command: "ls", fence: 1 };
  const killed = { commandId: "card-y", executionId: "shell:0", command: "pnpm build", fence: 2 };
  const resumed = { commandId: "card-z", executionId: "shell:1", command: "pnpm build", fence: 3 };
  const reused = { commandId: "card-c", executionId: "shell:1", command: "pnpm test", fence: 4 };
  const open = { exitCode: null, durationMs: null, stdout: null, stderr: null };
  return [
    commandEvent("command.intent", { ...listed, ...open, outcome: "waiting" }),
    commandEvent("command.finished", { ...listed, stdout: "src\n" }),
    commandEvent("command.intent", { ...killed, ...open, outcome: "waiting" }),
    commandEvent("command.started", { ...killed, ...open, outcome: "running" }),
    resumedEvent("shell:0", "shell:1", { fromCommandId: "card-y", toCommandId: "card-z" }),
    commandEvent("command.intent", { ...resumed, ...open, outcome: "waiting" }),
    commandEvent("command.finished", { ...resumed, stdout: "built\n" }),
    commandEvent("command.finished", { ...killed, outcome: "cancelled" }),
    commandEvent("command.intent", { ...reused, ...open, outcome: "waiting" }),
    commandEvent("command.finished", { ...reused, stdout: "tested\n" }),
  ].map((event, index) => ({ ...event, id: `event-${index}`, seq: 10 + index }));
}

const RESUMED_CALL_CARDS = [
  ["command:card-x", "ls", "completed", "src\n"],
  ["command:resumed:card-z", "pnpm build", "completed", "built\n"],
  ["command:card-c", "pnpm test", "completed", "tested\n"],
];

function shownCards(messages: readonly ThreadMessage[] | undefined) {
  const ids = (messages ?? []).map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
  return (messages ?? []).map((message) => {
    const [block] = message.blocks;
    const card = block?.kind === "command" ? block.command : undefined;
    return [message.id, card?.command, card?.outcome, card?.stdout];
  });
}

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

function resumedEvent(
  from: string,
  to: string,
  commandIds: { fromCommandId: string; toCommandId: string },
  seq = 4,
): FixtureProductEvent {
  return {
    id: "resumed",
    seq,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    createdAt: "2026-09-23T12:00:00.000Z",
    type: "agent.tool.resumed",
    payload: { from, to, ...commandIds },
  };
}
