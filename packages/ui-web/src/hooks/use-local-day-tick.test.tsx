// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { useLocalDayTick } from "./use-local-day-tick.js";

describe("useLocalDayTick", () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

  it("returns current local day key and updates across midnight", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 24, 23, 59, 30));

    let currentDayKey = "";
    function TestComponent() {
      currentDayKey = useLocalDayTick();
      return null;
    }

    const host = document.createElement("div");
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<TestComponent />);
      });

      expect(currentDayKey).toBe("2026-09-24");
      expect(vi.getTimerCount()).toBe(1);

      await act(async () => {
        await vi.advanceTimersByTimeAsync(40_000);
      });

      expect(currentDayKey).toBe("2026-09-25");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });

  it("rechecks day key and reschedules on document visibilitychange", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 24, 20, 0, 0));

    let currentDayKey = "";
    function TestComponent() {
      currentDayKey = useLocalDayTick();
      return null;
    }

    const host = document.createElement("div");
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(<TestComponent />);
      });

      expect(currentDayKey).toBe("2026-09-24");

      vi.setSystemTime(new Date(2026, 8, 25, 8, 0, 0));

      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"));
      });

      expect(currentDayKey).toBe("2026-09-25");
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      await act(async () => {
        root.unmount();
      });
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    }
  });
});
