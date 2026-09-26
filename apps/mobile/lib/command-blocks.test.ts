import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
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
    expect(isMobileThreadSnapshotEvent(resumedEvent("execution-1", "execution-2"))).toBe(true);
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
    const event = resumedEvent("execution-1", "execution-2");
    // The live stream, like `thread.tsx`, only applies events the snapshot filter admits.
    const next = isMobileThreadSnapshotEvent(event)
      ? applyMobileThreadEvent(started, event)
      : started;
    expect(next?.messages[0]?.id).toBe("command:resumed:run-1:execution-2");
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

function resumedEvent(from: string, to: string, seq = 4): FixtureProductEvent {
  return {
    id: "resumed",
    seq,
    spaceId: "space-1",
    threadId: "thread-1",
    botId: "bot-1",
    runId: "run-1",
    createdAt: "2026-09-23T12:00:00.000Z",
    type: "agent.tool.resumed",
    payload: { from, to },
  };
}
