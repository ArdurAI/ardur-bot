import type {
  CommandBlock as FixtureCommandBlock,
  ProductEvent as FixtureProductEvent,
} from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import type { MobileSnapshot } from "./api.js";
import { applyMobileThreadEvent } from "./api.js";

vi.mock("expo-secure-store", () => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
  deleteItemAsync: vi.fn(),
}));
vi.mock("./ai-consent", () => ({ promptAiConsent: vi.fn() }));
vi.mock("./live-notifications", () => ({ resumeLiveNotifications: vi.fn() }));

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
