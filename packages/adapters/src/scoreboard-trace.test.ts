import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTraceBuffer,
  startScoreboardTrace,
  traceCurrent,
  tracePoint,
  traceRuntime,
} from "./scoreboard-trace.js";

let stop: (() => void) | undefined;
afterEach(() => {
  stop?.();
  stop = undefined;
});

describe("bounded production trace", () => {
  it("drops telemetry without backpressure and never retains undeclared data", () => {
    const buffer = createTraceBuffer({ capacity: 2, now: () => 10 });
    const detail = { attempt: 1, prompt: "synthetic secret", result: "private result" };
    buffer.record("run-a", "tool.started", detail);
    buffer.record("run-a", "tool.finished", { outcome: "failed" });
    buffer.record("run-a", "terminal.committed", { outcome: "failed" });
    expect(buffer.snapshot().counters).toEqual({
      recorded: 2,
      dropped: 1,
      sampledOut: 0,
      invalid: 0,
    });
    expect(JSON.stringify(buffer.snapshot())).not.toMatch(/synthetic secret|private result|prompt/);
    const drained = buffer.drain();
    buffer.record("run-b", "admission.started");
    expect(drained.points).toHaveLength(2);
    expect(buffer.snapshot().points[0]!.sequence).toBe(2);
  });

  it("makes one deterministic sampling decision for every boundary across processes", () => {
    const first = createTraceBuffer({ sampleRate: 0.5, processId: "first", now: () => 1 });
    const second = createTraceBuffer({ sampleRate: 0.5, processId: "second", now: () => 100 });
    for (let i = 0; i < 100; i++) {
      first.record(`run-${i}`, "admission.started");
      second.record(`run-${i}`, "terminal.committed");
    }
    expect(first.snapshot().points.map((p) => p.traceId)).toEqual(
      second.snapshot().points.map((p) => p.traceId),
    );
    expect(first.snapshot().counters.sampledOut).toBeGreaterThan(0);
  });

  it("keeps telemetry clock failures and invalid values off the product failure path", () => {
    const buffer = createTraceBuffer({
      now: () => {
        throw new Error("clock unavailable");
      },
    });
    expect(() => buffer.record("run-a", "admission.started")).not.toThrow();
    buffer.record("run-a", "tool.started", { operationId: "body with spaces" }, 0);
    buffer.record("run-a", "tool.started", {}, Number.NaN);
    expect(buffer.snapshot().counters.invalid).toBe(3);
    expect(() => createTraceBuffer({ capacity: Infinity })).toThrow();
  });

  it("preserves concurrent run attribution and cancellation cleanup", async () => {
    const capture = startScoreboardTrace();
    stop = capture.stop;
    async function* source() {
      traceCurrent("provider.started", { operationId: "request-1" });
      try {
        await Promise.resolve();
        yield 1;
        yield 2;
      } finally {
        traceCurrent("provider.finished", { operationId: "request-1", outcome: "cancelled" });
      }
    }
    await Promise.all(
      ["run-a", "run-b"].map(async (id) => {
        for await (const _ of traceRuntime(id, 2, source())) break;
      }),
    );
    for (const id of ["run-a", "run-b"]) {
      expect(
        capture
          .snapshot()
          .points.filter((p) => p.traceId === id)
          .map((p) => p.boundary),
      ).toEqual(["provider.started", "provider.finished"]);
    }
    capture.stop();
    tracePoint("run-c", "admission.started");
    expect(capture.snapshot().points).toHaveLength(4);
  });

  it("preserves iterator completion and errors without adding a cleanup call", async () => {
    const cleanup = vi.fn(async () => ({ done: true as const, value: undefined }));
    const source = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: true as const, value: undefined }),
        return: cleanup,
      }),
    };
    expect(traceRuntime("run-a", 0, source)).toBe(source);
    const capture = startScoreboardTrace();
    stop = capture.stop;
    for await (const _ of traceRuntime("run-a", 0, source)) {
      throw new Error("Unexpected value");
    }
    const failure = new Error("runtime failed");
    const broken = {
      [Symbol.asyncIterator]: () => ({
        next: () => Promise.reject(failure),
        return: cleanup,
      }),
    };
    await expect(
      (async () => {
        for await (const _ of traceRuntime("run-a", 0, broken)) {
          throw new Error("Unexpected value");
        }
      })(),
    ).rejects.toBe(failure);
    expect(cleanup).not.toHaveBeenCalled();
  });
});
