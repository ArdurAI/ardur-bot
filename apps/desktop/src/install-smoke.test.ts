import { afterEach, describe, expect, it, vi } from "vitest";
import {
  installSmokeEnabled,
  runInstallSmoke,
  startInstallSmokeWatchdog,
} from "./install-smoke.js";

function boundary() {
  return {
    start: vi.fn(async () => ({ phase: "ready" })),
    healthy: vi.fn(async () => true),
    open: vi.fn(async () => true),
    screenshot: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    report: vi.fn(),
    stage: vi.fn(),
  };
}

describe("install acceptance smoke", () => {
  it("requires the exact opt-in", () => {
    for (const value of [undefined, "", "true", "0"]) {
      expect(installSmokeEnabled({ ARDUR_INSTALL_SMOKE: value })).toBe(false);
    }
    expect(installSmokeEnabled({ ARDUR_INSTALL_SMOKE: "1" })).toBe(true);
  });

  it("reports success only after health, a loaded window, screenshot and cleanup", async () => {
    const deps = boundary();
    await runInstallSmoke(deps);
    expect(deps.report).toHaveBeenCalledWith("ARDUR_INSTALL_SMOKE_PASS");
    const order = [
      deps.start,
      deps.healthy,
      deps.open,
      deps.screenshot,
      deps.stop,
      deps.report,
    ].map((call) => call.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(deps.stage.mock.calls.map(([stage]) => stage)).toEqual([
      "services starting",
      "health ok",
      "window loading",
      "window loaded",
      "screenshot capturing",
      "services stopping",
      "services stopped",
    ]);
  });

  it.each(["stack", "health", "window", "capture", "cleanup"])(
    "fails closed on %s failure and stops owned services",
    async (failure) => {
      const deps = boundary();
      if (failure === "stack") deps.start.mockResolvedValue({ phase: "failed" });
      if (failure === "health") deps.healthy.mockResolvedValue(false);
      if (failure === "window") deps.open.mockResolvedValue(false);
      if (failure === "capture") deps.screenshot.mockRejectedValue(new Error("capture failed"));
      if (failure === "cleanup") deps.stop.mockRejectedValue(new Error("cleanup failed"));
      await expect(runInstallSmoke(deps)).rejects.toThrow();
      expect(deps.stop).toHaveBeenCalled();
      expect(deps.report).not.toHaveBeenCalled();
    },
  );
});

describe("install smoke startup watchdog", () => {
  afterEach(() => vi.useRealTimers());

  it.each(["main module loading", "runtime installing", "services stopping", "quit requested"])(
    "bounds a hang at %s, including before services start and after success",
    (stage) => {
      vi.useFakeTimers();
      const deps = { report: vi.fn(), exit: vi.fn() };
      const progress = startInstallSmokeWatchdog(deps);
      expect(deps.report).toHaveBeenCalledWith("smoke: main module loading");
      progress.stage(stage);
      vi.advanceTimersByTime(149_999);
      expect(deps.exit).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(deps.report).toHaveBeenLastCalledWith(`smoke: timed out at ${stage}`);
      expect(deps.exit).toHaveBeenCalledWith(1);
      progress.dispose();
    },
  );

  it("reports an import failure with the stage and exits nonzero", () => {
    const deps = { report: vi.fn(), exit: vi.fn() };
    const progress = startInstallSmokeWatchdog(deps);
    progress.fail(new Error("unsupported module"));
    expect(deps.report).toHaveBeenLastCalledWith(
      "smoke: failed at main module loading: Error: unsupported module",
    );
    expect(deps.exit).toHaveBeenCalledWith(1);
    progress.dispose();
  });
});
