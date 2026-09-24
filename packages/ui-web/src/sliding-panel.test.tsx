// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SlidingPanel } from "./sliding-panel.js";

it("retains closed content only for the exit transition and makes it inert immediately", async () => {
  vi.useFakeTimers();
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SlidingPanel open panel="settings">
          <button type="button">Setting</button>
        </SlidingPanel>,
      ),
    );
    await act(async () =>
      root.render(
        <SlidingPanel open={false} panel="closed">
          {null}
        </SlidingPanel>,
      ),
    );
    expect(host.querySelector("aside")?.hasAttribute("inert")).toBe(true);
    expect(host.textContent).toContain("Setting");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200);
    });
    expect(host.textContent).not.toContain("Setting");
    await act(async () =>
      root.render(
        <SlidingPanel open panel="settings">
          <button type="button">New setting</button>
        </SlidingPanel>,
      ),
    );
    expect(host.querySelector("aside")?.hasAttribute("inert")).toBe(false);
    expect(host.textContent).toBe("New setting");
  } finally {
    await act(async () => root.unmount());
    vi.useRealTimers();
  }
});
