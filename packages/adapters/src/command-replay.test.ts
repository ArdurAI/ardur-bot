import type { CommandBlock as FixtureCommandBlock } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { approvalPausedToolResult } from "./approval-effect.js";
import {
  commandComputerFingerprint,
  commandReplayEvents,
  validateCommandReplay,
} from "./command-replay.js";

describe("exact command replay", () => {
  const computer = {
    id: "computer-1",
    kind: "docker",
    scope: "team",
    homeKey: "team-space-1",
    providerRef: "container-1",
  };
  const request = { command: "pnpm test", cwd: "/workspace" };
  const payload = {
    block: commandBlock(),
    replay: {
      request,
      computerFingerprint: commandComputerFingerprint(computer, "container-1", "/workspace"),
    },
  };
  it("validates original request independently of display text", () => {
    const result = validateCommandReplay(
      { ...payload, block: commandBlock({ command: "display only" }) },
      computer,
    );
    expect(result).toEqual({ commandId: "command-1", request });
    expect(validateCommandReplay({ ...payload, replay: null }, computer)).toHaveProperty("reason");
  });
  it.each([
    { ...computer, id: "computer-2" },
    { ...computer, providerRef: "replacement" },
    { ...computer, homeKey: "replacement-root" },
    { ...computer, scope: "dedicated" },
  ])("rejects identity or root drift", (changed) => {
    expect(validateCommandReplay(payload, changed)).toHaveProperty("reason");
    expect(validateCommandReplay(payload, computer, "/other-root")).toHaveProperty("reason");
  });
  it("uses a new run-scoped execution identity and respects an authoritative pause", async () => {
    const execute = vi.fn(async () => approvalPausedToolResult());
    const events = [];
    for await (const event of commandReplayEvents(
      { commandId: "command-1", request },
      "new-run",
      execute,
    ))
      events.push(event);
    expect(execute).toHaveBeenCalledWith("shell", request, "rerun:new-run");
    expect(events).toEqual([]);
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
