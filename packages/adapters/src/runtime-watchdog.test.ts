import type { AgentRuntimeEvent } from "@ardurbot/adapter-kit";
import { StepDeadlineExceeded } from "@ardurbot/core";
import { afterEach, expect, it, vi } from "vitest";
import { MODEL_STREAM_TIMEOUT_MS } from "./pi-runtime-limits.js";
import { withRuntimeCleanup } from "./runtime-stream.js";
import { createRuntimeWatchdog, watchRuntimeActivity } from "./runtime-watchdog.js";

afterEach(() => vi.useRealTimers());

it("fails an inactive stream even when next and return ignore abort", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const next = vi.fn(() => new Promise<IteratorResult<AgentRuntimeEvent>>(() => {}));
  const close = vi.fn(() => new Promise<IteratorResult<AgentRuntimeEvent>>(() => {}));
  const events = { [Symbol.asyncIterator]: () => ({ next, return: close }) };
  const consume = async () => {
    for await (const _ of withRuntimeCleanup(
      watchRuntimeActivity(events, createRuntimeWatchdog(controller)),
      controller,
    )) {
    }
  };
  const checked = expect(consume()).rejects.toMatchObject({
    message: "The bot stopped responding. Retry the run.",
    step: "runtime",
  });
  await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS - 1);
  expect(controller.signal.aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await checked;
  expect(controller.signal.reason).toBeInstanceOf(StepDeadlineExceeded);
  expect(close).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("counts real activity, not lease renewal, and gives an owned long tool its own deadline", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const watchdog = createRuntimeWatchdog(controller);
  let finish!: () => void;
  const waiting = watchdog.next(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const toolFinished = watchdog.beginTool();
  await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS * 2);
  expect(controller.signal.aborted).toBe(false);
  toolFinished();
  await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS - 1);
  expect(controller.signal.aborted).toBe(false);
  finish();
  await waiting;
  expect(vi.getTimerCount()).toBe(0);
});

it("shared shutdown interrupts an inactive adapter without waiting for its return", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const shutdown = new AbortController();
  const watchdog = createRuntimeWatchdog(controller, shutdown.signal);
  const checked = expect(watchdog.next(() => new Promise(() => {}))).rejects.toThrow();
  shutdown.abort();
  await checked;
  await watchdog.close(() => new Promise(() => {}));
  expect(vi.getTimerCount()).toBe(0);
});

it("bounds an iterator that stays open after its done event with the shutdown budget", async () => {
  vi.useFakeTimers();
  const controller = new AbortController();
  const watchdog = createRuntimeWatchdog(controller);
  watchdog.finished();
  const waiting = watchdog.next(() => new Promise<never>(() => {}));
  const checked = expect(waiting).rejects.toMatchObject({ step: "runtime" });
  await vi.advanceTimersByTimeAsync(60_000);
  await checked;
  expect(controller.signal.aborted).toBe(true);
});

it("does not start another runtime request after inactivity has already expired", async () => {
  vi.useFakeTimers();
  const watchdog = createRuntimeWatchdog(new AbortController());
  await vi.advanceTimersByTimeAsync(MODEL_STREAM_TIMEOUT_MS);
  const next = vi.fn(async () => undefined);
  await expect(watchdog.next(next)).rejects.toMatchObject({ step: "runtime" });
  expect(next).not.toHaveBeenCalled();
});
