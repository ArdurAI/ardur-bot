import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import { reportRuntimeWaits, withRuntimeCleanup } from "./runtime-stream.js";

describe("executor runtime cleanup", () => {
  it.each(["cancelled", "lease lost", "pause", "consumer error"])(
    "settles runtime and tool work before ownership cleanup on %s",
    async (reason) => {
      const controller = new AbortController();
      const order: string[] = [];
      let finishTool!: () => void;
      const tool = new Promise<void>((resolve) => {
        finishTool = resolve;
      });
      controller.signal.addEventListener("abort", () => {
        order.push("abort");
      });
      async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
        try {
          yield { type: "text", text: "started" };
        } finally {
          order.push("closing");
          await tool;
          order.push("settled");
        }
      }
      const consume = async () => {
        try {
          for await (const _event of withRuntimeCleanup(runtime(), controller)) {
            if (reason === "consumer error") throw new Error("consumer failed");
            if (reason === "lease lost") controller.abort();
            return;
          }
        } finally {
          order.push("release ownership");
        }
      };
      const consuming = consume().catch((error: Error) => error.message);
      await vi.waitFor(() => expect(order).toEqual(["abort", "closing"]));
      finishTool();
      expect(await consuming).toBe(reason === "consumer error" ? "consumer failed" : undefined);
      expect(order).toEqual(["abort", "closing", "settled", "release ownership"]);
    },
  );

  it("keeps the context usable for checkpoints after normal completion", async () => {
    const controller = new AbortController();
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "done" };
    }
    for await (const _event of withRuntimeCleanup(runtime(), controller)) {
      // Consume the runtime normally.
    }
    expect(controller.signal.aborted).toBe(false);
  });

  it("cancels tool work and closes the iterator after a runtime failure", async () => {
    const controller = new AbortController();
    const close = vi.fn(async () => {
      expect(controller.signal.aborted).toBe(true);
      return { done: true as const, value: undefined };
    });
    const events = {
      [Symbol.asyncIterator]: () => ({
        next: async () => {
          throw new Error("runtime failed");
        },
        return: close,
      }),
    };
    const consume = async () => {
      for await (const _event of withRuntimeCleanup(events, controller)) {
      }
    };
    await expect(consume()).rejects.toThrow("runtime failed");
    expect(close).toHaveBeenCalledOnce();
  });
});

describe("runtime waits", () => {
  it("reports a wait only while its consumer asks the runtime for the next event", async () => {
    const waits: boolean[] = [];
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    async function* runtime(): AsyncIterable<AgentRuntimeEvent> {
      yield { type: "text", text: "narration" };
      await held;
      yield { type: "done" };
    }
    const iterator = reportRuntimeWaits(runtime(), (value) => waits.push(value))[
      Symbol.asyncIterator
    ]();
    await iterator.next();
    // The consumer is still handling the text event, such as saving usage: no wait.
    expect(waits).toEqual([true, false]);
    const pending = iterator.next();
    expect(waits).toEqual([true, false, true]);
    release();
    await pending;
    expect(await iterator.next()).toEqual({ done: true, value: undefined });
    expect(waits).toEqual([true, false, true, false, true]);
  });

  it("closes the runtime when its consumer stops early", async () => {
    const close = vi.fn(async () => ({ done: true as const, value: undefined }));
    const events = {
      [Symbol.asyncIterator]: () => ({
        next: async () => ({ done: false as const, value: { type: "done" as const } }),
        return: close,
      }),
    };
    for await (const _event of reportRuntimeWaits(events, () => {})) break;
    expect(close).toHaveBeenCalledOnce();
  });
});
