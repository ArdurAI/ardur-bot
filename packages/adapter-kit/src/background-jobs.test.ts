import { describe, expect, it, vi } from "vitest";
import {
  dispatchBackgroundJob,
  evidenceSealJob,
  hermesInstallJob,
  historyCompactJob,
  historyCompactJobKey,
  messagingDeliverJob,
  parseBackgroundJob,
} from "./background-jobs.js";
import type { BackgroundJobHandlers } from "./types.js";

function handlers(): BackgroundJobHandlers {
  return {
    "board.run": vi.fn(async () => undefined),
    "briefs.maintain": async () => undefined,
    "learning.curate": async () => undefined,
    "learning.insights": async () => undefined,
    "learning.review": async () => undefined,
    "memory.git-push": async () => undefined,
    "memory.deliver": async () => undefined,
    "run.continue": vi.fn(async () => undefined),
    "evidence.seal": vi.fn(async () => undefined),
    "routine.wakeup": vi.fn(async () => undefined),
    "computer.update": vi.fn(async () => undefined),
    "computer.sleep": vi.fn(async () => undefined),
    "computer.control-expire": vi.fn(async () => undefined),
    "skill.teaching-expire": vi.fn(async () => undefined),
    "history.compact": vi.fn(async () => undefined),
    "messaging.deliver": vi.fn(async () => undefined),
    "cloud_agent.poll": vi.fn(async () => undefined),
    "hermes.install": vi.fn(async () => undefined),
  };
}

describe("background job contracts", () => {
  it("validates and dispatches evidence sealing with the run id as key", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "evidence.seal", { runId: "run-1" });
    expect(target["evidence.seal"]).toHaveBeenCalledWith({ runId: "run-1" });
    expect(evidenceSealJob("run-1")).toEqual({
      name: "evidence.seal",
      payload: { runId: "run-1" },
      replaceKey: "run-1",
    });
    expect(() => parseBackgroundJob("evidence.seal", { runId: "" })).toThrow();
    expect(() => parseBackgroundJob("evidence.seal", { runId: "run", args: "private" })).toThrow();
  });
  it("validates and dispatches messaging.deliver", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "messaging.deliver", { runId: "run-1" });
    expect(target["messaging.deliver"]).toHaveBeenCalledWith({ runId: "run-1" });
    expect(messagingDeliverJob("run-1")).toEqual({
      name: "messaging.deliver",
      payload: { runId: "run-1" },
      replaceKey: "messaging.deliver:run-1",
    });
    expect(messagingDeliverJob()).toEqual({
      name: "messaging.deliver",
      payload: {},
      replaceKey: "messaging.deliver:drain",
    });
  });

  it("validates and dispatches a typed job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "routine.wakeup", {
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
    expect(target["routine.wakeup"]).toHaveBeenCalledWith({
      routineId: "routine-1",
      scheduledFor: "2026-08-15T12:00:00.000Z",
    });
  });

  it("accepts only an empty Hermes install payload", () => {
    expect(parseBackgroundJob("hermes.install", {})).toEqual({
      name: "hermes.install",
      payload: {},
    });
    expect(hermesInstallJob()).toEqual({
      name: "hermes.install",
      payload: {},
      replaceKey: "hermes.install",
    });
    expect(() => parseBackgroundJob("hermes.install", { root: "no" })).toThrow();
    expect(() => parseBackgroundJob("hermes.install", { url: "no" })).toThrow();
    expect(() => parseBackgroundJob("hermes.install", { version: "no" })).toThrow();
  });

  it("rejects unknown names and malformed deliveries", () => {
    expect(() => parseBackgroundJob("unknown", {})).toThrow("Unknown background job");
    expect(() =>
      parseBackgroundJob("routine.wakeup", {
        routineId: "routine-1",
        scheduledFor: "not-a-date",
      }),
    ).toThrow();
    expect(() => parseBackgroundJob("run.continue", { runId: "" })).toThrow();
    expect(() =>
      parseBackgroundJob("computer.control-expire", {
        computerId: "computer-1",
        leaseId: "",
      }),
    ).toThrow();
  });

  it("validates and dispatches a control-expiry job", async () => {
    const target = handlers();
    await dispatchBackgroundJob(target, "computer.control-expire", {
      computerId: "computer-1",
      leaseId: "lease-1",
    });
    expect(target["computer.control-expire"]).toHaveBeenCalledWith({
      computerId: "computer-1",
      leaseId: "lease-1",
    });
  });
});

describe("historyCompactJob", () => {
  it("builds a job with a replace key scoped to the thread", () => {
    expect(historyCompactJob("thread-1")).toEqual({
      name: "history.compact",
      payload: { threadId: "thread-1" },
      replaceKey: historyCompactJobKey("thread-1"),
    });
  });

  it("keys different threads differently", () => {
    expect(historyCompactJobKey("thread-1")).not.toBe(historyCompactJobKey("thread-2"));
  });
});
