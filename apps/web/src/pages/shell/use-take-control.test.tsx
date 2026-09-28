// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { useTakeControl } from "./use-take-control";

describe("useTakeControl", () => {
  it("sets takingControl true while waiting and handles errors", async () => {
    let rejectPromise!: (reason?: any) => void;
    let resolvePromise!: () => void;
    const promise = new Promise<void>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const bootComputer = vi.fn().mockReturnValue(promise);
    
    let currentTakingControl = false;
    let takeControlFn!: (botId: string) => Promise<void>;
    
    function TestComponent() {
      const { takingControl, takeControl } = useTakeControl(bootComputer);
      currentTakingControl = takingControl;
      takeControlFn = takeControl;
      return null;
    }
    
    const container = document.createElement("div");
    const root = createRoot(container);
    await act(async () => {
      root.render(<TestComponent />);
    });
    
    expect(currentTakingControl).toBe(false);

    let caughtError: unknown;
    let takeControlPromise: Promise<void>;
    act(() => {
      takeControlPromise = takeControlFn("bot-1").catch(e => { caughtError = e; });
    });

    expect(currentTakingControl).toBe(true);
    expect(bootComputer).toHaveBeenCalledWith({ botId: "bot-1", takeControl: true, overlay: false });

    await act(async () => {
      rejectPromise(new Error("Network error"));
      await takeControlPromise;
    });

    expect(currentTakingControl).toBe(false);
    expect(caughtError).toBeUndefined(); // Caught internally
    
    root.unmount();
  });
});
