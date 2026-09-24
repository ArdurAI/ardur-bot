import { afterEach, describe, expect, it, vi } from "vitest";
import { EXECUTION_TICK_MS, startExecutionHeartbeat } from "./execution-heartbeat.js";

afterEach(() => vi.useRealTimers());
describe("execution heartbeat", () => {
  it("coalesces 61 old timer callbacks into 12 per active minute, retaining minute renewals", async () => {
    vi.useFakeTimers();
    const checkStop = vi.fn(async () => {});
    const renew = vi.fn(async () => {});
    const stop = startExecutionHeartbeat({ checkStop, renew, onFailure: vi.fn() });
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStop).toHaveBeenCalledTimes(12);
    expect(renew).toHaveBeenCalledOnce();
    stop();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(checkStop).toHaveBeenCalledTimes(12);
  });
  it("does not overlap slow checks and fails closed on database failure", async () => {
    vi.useFakeTimers();
    let reject!: (error: Error) => void;
    const checkStop = vi.fn(
      () =>
        new Promise<void>((_, fail) => {
          reject = fail;
        }),
    );
    const onFailure = vi.fn();
    const stop = startExecutionHeartbeat({ checkStop, renew: vi.fn(async () => {}), onFailure });
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS * 4);
    expect(checkStop).toHaveBeenCalledOnce();
    reject(new Error("Unavailable"));
    await vi.advanceTimersByTimeAsync(0);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });
  it("checks cancellation within one tick and suppresses callbacks after cleanup", async () => {
    vi.useFakeTimers();
    const aborted = vi.fn();
    const stop = startExecutionHeartbeat({
      checkStop: async () => {
        aborted();
      },
      renew: async () => {},
      onFailure: vi.fn(),
    });
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS);
    expect(aborted).toHaveBeenCalledOnce();
    stop();
    await vi.advanceTimersByTimeAsync(EXECUTION_TICK_MS);
    expect(aborted).toHaveBeenCalledOnce();
  });
});
