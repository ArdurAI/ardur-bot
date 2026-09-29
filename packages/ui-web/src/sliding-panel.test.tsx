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

it("sets max-width appropriately for panel types", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SlidingPanel open panel="settings">
          <div />
        </SlidingPanel>,
      ),
    );
    const aside = host.querySelector("aside");
    expect(aside?.className).toContain("max-w-[384px]");
    expect(aside?.className).not.toContain("max-w-full");

    await act(async () =>
      root.render(
        <SlidingPanel open panel="computer" workspace expanded>
          <div />
        </SlidingPanel>,
      ),
    );
    const expandedAside = host.querySelector("aside");
    expect(expandedAside?.className).toContain("max-w-none");
  } finally {
    await act(async () => root.unmount());
  }
});

it("opens wide panels at 560 px with their own remembered width", async () => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  const host = document.createElement("div");
  let root = createRoot(host);
  const handle = () => host.querySelector("hr");
  try {
    await act(async () =>
      root.render(
        <SlidingPanel open panel="settings" size="wide">
          <div />
        </SlidingPanel>,
      ),
    );
    const aside = host.querySelector("aside");
    expect(aside?.className).toContain("md:w-(--pane-width)");
    expect(aside?.className).not.toContain("max-w-[384px]");
    expect(aside?.style.getPropertyValue("--pane-width")).toBe("min(560px, calc(100vw - 400px))");
    expect(handle()?.getAttribute("aria-valuemin")).toBe("384");
    expect(handle()?.getAttribute("aria-valuemax")).toBe("800");
    await act(async () => {
      handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });
    expect(handle()?.getAttribute("aria-valuenow")).toBe("580");
    expect(saved.get("ardurbot:settings-pane-width")).toBe("580");

    await act(async () =>
      root.render(
        <SlidingPanel open panel="computer" workspace>
          <div />
        </SlidingPanel>,
      ),
    );
    expect(handle()?.getAttribute("aria-valuenow")).toBe("480");
    expect(handle()?.getAttribute("aria-valuemin")).toBe("360");
    expect(saved.get("ardurbot:pane-width")).toBe("480");
    expect(saved.get("ardurbot:settings-pane-width")).toBe("580");

    await act(async () => root.unmount());
    root = createRoot(host);
    await act(async () =>
      root.render(
        <SlidingPanel open panel="group-settings" size="wide">
          <div />
        </SlidingPanel>,
      ),
    );
    expect(handle()?.getAttribute("aria-valuenow")).toBe("580");
    for (let step = 0; step < 20; step++) {
      await act(async () => {
        handle()?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
      });
    }
    expect(handle()?.getAttribute("aria-valuenow")).toBe("384");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("keeps narrow panels at 384 px without a resize handle", async () => {
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () =>
      root.render(
        <SlidingPanel open panel="create" size="narrow">
          <div />
        </SlidingPanel>,
      ),
    );
    expect(host.querySelector("aside")?.className).toContain("max-w-[384px]");
    expect(host.querySelector("hr")).toBeNull();
  } finally {
    await act(async () => root.unmount());
  }
});
