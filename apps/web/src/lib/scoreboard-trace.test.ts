import type { ProductEvent, ThreadSnapshot } from "@ardurbot/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clientTraceSnapshot,
  paintThreadTrace,
  receiveTraceEvent,
  traceRpc,
} from "./scoreboard-trace";

afterEach(() => {
  delete globalThis.__ardurTrace;
  vi.unstubAllGlobals();
});
const event = (
  type: ProductEvent["type"],
  seq: number,
  payload: ProductEvent["payload"] = {},
): ProductEvent => ({
  id: `event-${seq}`,
  type,
  seq,
  payload,
  runId: "run-a",
  threadId: "thread-a",
  botId: "bot-a",
  spaceId: "space-a",
  createdAt: "2026-01-01T00:00:00Z",
});
const snapshot = (cursor: number): ThreadSnapshot => ({
  threadId: "thread-a",
  cursor,
  run: null,
  olderCursor: null,
  messages: [
    {
      id: "message-a",
      threadId: "thread-a",
      seq: cursor,
      runId: "run-a",
      role: "bot",
      blocks: [{ kind: "progress", text: "synthetic content" }],
      createdAt: "2026-01-01T00:00:00Z",
    },
  ],
});
function frames() {
  const callbacks = new Map<number, FrameRequestCallback>();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    callbacks.set(++id, fn);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => callbacks.delete(id));
  vi.stubGlobal("document", {
    visibilityState: "visible",
    querySelector: () => ({
      getBoundingClientRect: () => ({
        top: 0,
        left: 0,
        bottom: 30,
        right: 40,
        width: 40,
        height: 30,
      }),
    }),
  });
  vi.stubGlobal("innerHeight", 900);
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("getComputedStyle", () => ({ visibility: "visible", opacity: "1" }));
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  return () => {
    const next = [...callbacks];
    callbacks.clear();
    for (const [, fn] of next) fn(0);
  };
}

describe("client trace", () => {
  it("retains the submission boundary captured before a cold collector import", async () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const beforeImport = performance.now();
    await traceRpc(["threads", "send"], async () => ({ runId: "run-a" }), beforeImport);
    expect(clientTraceSnapshot()!.points[0]).toMatchObject({
      boundary: "client.submitted",
      at: beforeImport,
    });
  });
  it("correlates a receipt arriving after streamed text without retaining content", async () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    await traceRpc(["threads", "send"], async () => {
      receiveTraceEvent(
        event("thread.progress", 1, { text: "synthetic content", streaming: true }),
      );
      return { runId: "run-a" };
    });
    paintThreadTrace(snapshot(1));
    tick();
    expect(clientTraceSnapshot()!.points.some((p) => p.boundary === "client.text.painted")).toBe(
      false,
    );
    tick();
    const points = clientTraceSnapshot()!.points;
    expect(points.find((p) => p.boundary === "client.text.painted")!.at).toBeGreaterThanOrEqual(
      points.find((p) => p.boundary === "client.submitted")!.at,
    );
    expect(JSON.stringify(clientTraceSnapshot())).not.toContain("synthetic content");
  });

  it("never labels placeholder activity, hidden tabs or an uncommitted terminal event as painted", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    receiveTraceEvent(event("thread.progress", 1, { text: "Working…" }));
    receiveTraceEvent(event("run.failed", 3));
    paintThreadTrace(snapshot(1));
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.map((p) => p.boundary)).toEqual(["client.received"]);
    vi.stubGlobal("document", { visibilityState: "hidden" });
    paintThreadTrace(snapshot(3));
    tick();
    tick();
    expect(clientTraceSnapshot()!.points).toHaveLength(1);
  });

  it("cancels stale renders and records terminal failure only after the current commit paints", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    receiveTraceEvent(event("run.failed", 3));
    const cancel = paintThreadTrace(snapshot(3));
    tick();
    cancel?.();
    tick();
    expect(clientTraceSnapshot()!.points).toHaveLength(1);
    paintThreadTrace(snapshot(3));
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.at(-1)).toMatchObject({
      boundary: "client.terminal.painted",
      outcome: "failed",
    });
  });

  it("does not count a response outside the viewport as painted text", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    vi.stubGlobal("document", {
      visibilityState: "visible",
      querySelector: () => ({
        getBoundingClientRect: () => ({
          top: 950,
          left: 0,
          bottom: 980,
          right: 40,
          width: 40,
          height: 30,
        }),
      }),
    });
    receiveTraceEvent(event("thread.progress", 1, { text: "content", streaming: true }));
    paintThreadTrace(snapshot(1));
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.map((p) => p.boundary)).toEqual(["client.received"]);
  });

  it("uses the event cursor and message identity after a persisted snapshot wins the race", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    receiveTraceEvent(
      event("thread.message.created", 100, { messageId: "message-a", role: "bot" }),
    );
    const refreshed = snapshot(100);
    refreshed.messages[0]!.seq = 2;
    paintThreadTrace(refreshed);
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.at(-1)!.boundary).toBe("client.text.painted");
  });

  it("does not credit a resumed run's older bot message for the next streaming progress event", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    const resumed = snapshot(40);
    resumed.messages = [
      {
        id: "older-message",
        threadId: "thread-a",
        seq: 2,
        runId: "run-a",
        role: "bot",
        blocks: [{ kind: "text", text: "earlier answer" }],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    receiveTraceEvent(event("thread.progress", 40, { text: "new text", streaming: true }));
    paintThreadTrace(resumed);
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.map((point) => point.boundary)).toEqual([
      "client.received",
    ]);
    const painted = snapshot(40);
    painted.messages = [
      ...resumed.messages,
      {
        id: "progress:run-a",
        threadId: "thread-a",
        seq: 40,
        runId: "run-a",
        role: "bot",
        blocks: [{ kind: "progress", text: "new text" }],
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];
    paintThreadTrace(painted);
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.at(-1)!.boundary).toBe("client.text.painted");
  });

  it("records a streaming progress message id and does not paint an older visible row", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    const resumed = snapshot(40);
    resumed.messages = [
      {
        id: "older-message",
        threadId: "thread-a",
        seq: 100,
        runId: "run-a",
        role: "bot",
        blocks: [{ kind: "text", text: "earlier answer" }],
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    receiveTraceEvent(
      event("thread.progress", 40, {
        text: "new text",
        streaming: true,
        messageId: "fresh",
      }),
    );
    paintThreadTrace(resumed);
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.map((point) => point.boundary)).toEqual([
      "client.received",
    ]);
    const named = snapshot(40);
    named.messages = [
      ...resumed.messages,
      {
        id: "fresh",
        threadId: "thread-a",
        seq: 3,
        runId: "run-a",
        role: "bot",
        blocks: [{ kind: "text", text: "new text" }],
        createdAt: "2026-01-01T00:00:01Z",
      },
    ];
    paintThreadTrace(named);
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.at(-1)!.boundary).toBe("client.text.painted");
  });

  it("does not mistake an older message from the same run for the pending durable message", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    receiveTraceEvent(
      event("thread.message.created", 10, { messageId: "new-message", role: "bot" }),
    );
    paintThreadTrace(snapshot(100));
    tick();
    tick();
    expect(clientTraceSnapshot()!.points.map((p) => p.boundary)).toEqual(["client.received"]);
  });

  it("keeps the two-frame observation pending through compatible committed snapshots", () => {
    globalThis.__ardurTrace = { capacity: 20 };
    const tick = frames();
    receiveTraceEvent(event("thread.progress", 1, { text: "content", streaming: true }));
    paintThreadTrace(snapshot(1));
    tick();
    const latest = snapshot(2);
    latest.messages = [];
    paintThreadTrace(latest);
    tick();
    expect(clientTraceSnapshot()!.points.map((p) => p.boundary)).toEqual(["client.received"]);
    paintThreadTrace(snapshot(3));
    tick();
    paintThreadTrace(snapshot(4));
    tick();
    expect(clientTraceSnapshot()!.points.at(-1)!.boundary).toBe("client.text.painted");
  });

  it("has a bounded buffer and preserves subscription errors", async () => {
    globalThis.__ardurTrace = { capacity: 1 };
    await traceRpc(["threads", "send"], async () => ({ runId: "run-a" }));
    expect(clientTraceSnapshot()!.counters.dropped).toBe(1);
    const stream = await traceRpc(["threads", "subscribe"], async () =>
      (async function* () {
        yield event("run.failed", 3);
        throw new Error("disconnected");
      })(),
    );
    await expect(
      (async () => {
        for await (const _ of stream as AsyncIterable<ProductEvent>) {
          /* consume */
        }
      })(),
    ).rejects.toThrow("disconnected");
    expect(clientTraceSnapshot()!.points).toHaveLength(1);
  });
});
