import type { DesktopLocalStackState } from "@ardurbot/contracts";
import { describe, expect, it, vi } from "vitest";
import { serviceGuidedStep } from "./services.js";

const context = { runId: "test-run" };

describe("guided services", () => {
  it("requires both controller readiness signals and keeps the data path out of the receipt", async () => {
    let apiHealth = true;
    let workerLine = false;
    const localMode = {
      servicesReady: vi.fn(async () => apiHealth && workerLine),
      startServices: vi.fn(async () => ({ phase: "ready" }) as DesktopLocalStackState),
      stop: vi.fn(async () => undefined),
    };
    const services = serviceGuidedStep({
      localMode,
      dataFolderFingerprint: "abc123",
      now: () => 100,
    });
    const signal = new AbortController().signal;
    expect(await services.check(context, signal)).toMatchObject({ kind: "needed" });
    expect(
      await services.verify(context, { kind: "owned", proof: "abc123" }, signal),
    ).toMatchObject({
      kind: "blocked",
      reasonCode: "services-not-ready",
    });
    apiHealth = false;
    workerLine = true;
    expect(await services.check(context, signal)).toMatchObject({ kind: "needed" });
    apiHealth = true;
    expect(await services.check(context, signal)).toMatchObject({ kind: "satisfied" });
    const receipt = await services.run(context, signal);
    expect(receipt).toEqual({ kind: "owned", proof: "services:abc123" });
    expect(JSON.stringify(receipt)).not.toContain("/fixture");
  });

  it("waits for stop settlement and rejects a stop timeout", async () => {
    vi.useFakeTimers();
    let settle!: () => void;
    const stop = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          settle = resolve;
        }),
    );
    const services = serviceGuidedStep({
      localMode: {
        servicesReady: async () => false,
        startServices: async () => ({ phase: "ready" }) as DesktopLocalStackState,
        stop,
      },
      dataFolderFingerprint: "abc123",
      now: () => 100,
      stopTimeoutMs: 20,
    });
    await services.run(context, new AbortController().signal);
    let stopped = false;
    const cancellation = services.cancel(context, null).then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    settle();
    await cancellation;
    expect(stopped).toBe(true);
    await services.run(context, new AbortController().signal);
    const timedOut = services.cancel(context, null);
    const rejection = expect(timedOut).rejects.toThrow("stop-timeout");
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    vi.useRealTimers();
  });
});
