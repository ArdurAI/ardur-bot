import { afterEach, expect, it, vi } from "vitest";
import { beforeDeadline, StepDeadlineExceeded } from "./deadline.js";

afterEach(() => vi.useRealTimers());

it("bounds a never-settling step and clears its timer after success", async () => {
  vi.useFakeTimers();
  const stalled = beforeDeadline("persist", Date.now() + 60_000, () => new Promise(() => {}));
  const checked = expect(stalled).rejects.toMatchObject({ step: "persist" });
  await vi.advanceTimersByTimeAsync(60_000);
  await checked;
  expect(vi.getTimerCount()).toBe(0);
  expect(await beforeDeadline("persist", Date.now() + 60_000, async () => "saved")).toBe("saved");
  expect(vi.getTimerCount()).toBe(0);
});

it("does not start work after the deadline or shutdown", async () => {
  const work = vi.fn(async () => "late");
  await expect(beforeDeadline("persist", Date.now(), work)).rejects.toBeInstanceOf(
    StepDeadlineExceeded,
  );
  const shutdown = new AbortController();
  shutdown.abort();
  await expect(
    beforeDeadline("persist", Date.now() + 60_000, work, shutdown.signal),
  ).rejects.toThrow();
  expect(work).not.toHaveBeenCalled();
});

it("interrupts waiting on the shared shutdown signal without swallowing late failures", async () => {
  vi.useFakeTimers();
  const shutdown = new AbortController();
  let reject!: (error: Error) => void;
  const stalled = beforeDeadline(
    "record",
    Date.now() + 60_000,
    () =>
      new Promise((_, fail) => {
        reject = fail;
      }),
    shutdown.signal,
  );
  const checked = expect(stalled).rejects.toThrow();
  shutdown.abort();
  await checked;
  reject(new Error("late failure"));
  await Promise.resolve();
  expect(vi.getTimerCount()).toBe(0);
});
