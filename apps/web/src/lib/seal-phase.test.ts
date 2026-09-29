import type { Run, ThreadMessage, ThreadSnapshot } from "@ardurbot/contracts";
import { SEAL_DONE_MS, SEAL_STARTING_MS } from "@ardurbot/core";
import { describe, expect, it } from "vitest";
import { botSealPhase, threadSealPhases } from "./seal-phase";

const now = Date.parse("2026-09-28T12:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

function run(id: string, botId: string, status: Run["status"], startedAt = now - 60_000): Run {
  return {
    id,
    botId,
    threadId: "thread",
    taskId: id,
    status,
    trigger: "user",
    routineId: null,
    modelProvider: null,
    modelId: null,
    error: status === "failed" ? "The provider is busy" : null,
    startedAt: iso(startedAt),
    completedAt: null,
    createdAt: iso(startedAt),
  };
}

function snapshot(
  runs: Run[],
  messages: ThreadMessage[] = [],
  failed: Run | null = null,
): ThreadSnapshot {
  return {
    threadId: "thread",
    cursor: 10,
    olderCursor: null,
    messages,
    run: failed ?? runs[0] ?? null,
    activeRuns: runs,
  };
}

const quiet = { completedAt: new Map<string, number>(), seenErrors: new Set<string>(), now };

describe("seal phases from the open thread", () => {
  it("reads each member's run and its live work record", () => {
    const phases = threadSealPhases(
      snapshot(
        [run("r1", "scout", "running"), run("r2", "writer", "waiting_input")],
        [
          {
            id: "progress:r1",
            threadId: "thread",
            seq: 9,
            role: "bot",
            runId: "r1",
            blocks: [{ kind: "steps", steps: [{ label: "Web search", count: 1 }] }],
            createdAt: iso(now),
          },
        ],
      ),
      quiet,
    );
    expect(Object.fromEntries(phases)).toEqual({
      scout: { phase: "searching" },
      writer: { phase: "waiting" },
    });
  });

  it("starts a run that has only just begun, until its start moment ends", () => {
    const startedAt = now - 200;
    const phases = threadSealPhases(snapshot([run("r1", "scout", "running", startedAt)]), quiet);
    expect(phases.get("scout")).toEqual({
      phase: "starting",
      until: startedAt + SEAL_STARTING_MS,
    });
  });

  it("shows a failed run's error until the reader dismisses it", () => {
    const failed = run("r1", "scout", "failed");
    expect(threadSealPhases(snapshot([], [], failed), quiet).get("scout")).toEqual({
      phase: "error",
    });
    expect(
      threadSealPhases(snapshot([], [], failed), { ...quiet, seenErrors: new Set(["r1"]) }).has(
        "scout",
      ),
    ).toBe(false);
  });

  it("shows done briefly after a run completes, then leaves the bot at rest", () => {
    const completedAt = new Map([["scout", now - 1_000]]);
    expect(threadSealPhases(snapshot([]), { ...quiet, completedAt }).get("scout")).toEqual({
      phase: "done",
      until: now - 1_000 + SEAL_DONE_MS,
    });
    expect(
      threadSealPhases(snapshot([]), { ...quiet, completedAt, now: now + SEAL_DONE_MS }).size,
    ).toBe(0);
  });

  it("lets a new run replace a recent completion", () => {
    const completedAt = new Map([["scout", now - 1_000]]);
    expect(
      threadSealPhases(snapshot([run("r2", "scout", "queued")]), { ...quiet, completedAt }).get(
        "scout",
      ),
    ).toEqual({ phase: "starting" });
  });
});

describe("a bot's seal phase", () => {
  it("prefers the open thread's view of its own runs", () => {
    expect(botSealPhase({ phase: "searching" }, "idle")).toBe("searching");
    expect(botSealPhase({ phase: "done" }, "running")).toBe("done");
  });

  it("falls back to the bot list for runs elsewhere", () => {
    expect(botSealPhase(undefined, "waiting_input")).toBe("waiting");
    expect(botSealPhase(undefined, "idle")).toBe("idle");
  });

  it("ends an error once the bot starts another run", () => {
    expect(botSealPhase({ phase: "error" }, "idle")).toBe("error");
    expect(botSealPhase({ phase: "error" }, "queued")).toBe("starting");
  });
});
