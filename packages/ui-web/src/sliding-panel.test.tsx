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

function press(separator: Element, key: string) {
  separator.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
}

function drag(separator: Element, from: number, to: number) {
  separator.dispatchEvent(new PointerEvent("pointerdown", { clientX: from, bubbles: true }));
  separator.dispatchEvent(new PointerEvent("pointermove", { clientX: to, bubbles: true }));
  separator.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }));
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => (values.has(key) ? (values.get(key) ?? null) : null),
    setItem: (key: string, value: string) => {
      values.set(key, String(value));
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
    clear: () => {
      values.clear();
    },
    key: (index: number) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

it("gives every side panel a keyboard and pointer resize within the conversation's room", async () => {
  const storage = memoryStorage();
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", { configurable: true, value: storage });
  document.documentElement.dir = "";
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
    const separator = host.querySelector("hr");
    expect(aside?.className).toContain("md:w-(--pane-width)");
    expect(aside?.className).not.toContain("max-w-[384px]");
    expect(aside?.getAttribute("style")).toContain("calc(100vw - 400px)");
    expect(separator?.getAttribute("aria-label")).toBe("Resize pane");
    expect(separator?.tabIndex).toBe(0);
    expect(separator?.getAttribute("aria-valuenow")).toBe("384");
    expect(separator?.getAttribute("aria-valuemin")).toBe("360");
    expect(separator?.getAttribute("aria-valuemax")).toBe("800");
    expect(separator?.parentElement?.className).toContain("hidden");
    expect(separator?.parentElement?.className).toContain("md:block");
    expect(host.querySelector("[aria-hidden='true']")?.className).toContain("md:w-(--pane-width)");

    await act(async () => press(separator!, "ArrowLeft"));
    expect(separator?.getAttribute("aria-valuenow")).toBe("404");
    expect(storage.getItem("ardurbot:pane-width:settings")).toBe("404");

    await act(async () => drag(separator!, 200, 80));
    expect(separator?.getAttribute("aria-valuenow")).toBe("524");

    await act(async () => press(separator!, "Home"));
    expect(separator?.getAttribute("aria-valuenow")).toBe("360");
    await act(async () => press(separator!, "ArrowRight"));
    expect(separator?.getAttribute("aria-valuenow")).toBe("360");
    await act(async () => press(separator!, "End"));
    expect(separator?.getAttribute("aria-valuenow")).toBe("800");
    await act(async () => press(separator!, "ArrowLeft"));
    expect(separator?.getAttribute("aria-valuenow")).toBe("800");
    expect(storage.getItem("ardurbot:pane-width:settings")).toBe("800");

    await act(async () =>
      root.render(
        <SlidingPanel open panel="routines">
          <div />
        </SlidingPanel>,
      ),
    );
    expect(host.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("384");
    expect(storage.getItem("ardurbot:pane-width:routines")).toBeNull();
    await act(async () => press(host.querySelector("hr")!, "ArrowLeft"));
    expect(storage.getItem("ardurbot:pane-width:routines")).toBe("404");
    expect(storage.getItem("ardurbot:pane-width:settings")).toBe("800");

    await act(async () => root.unmount());
    storage.setItem("ardurbot:pane-width", "600");
    const restored = createRoot(host);
    await act(async () =>
      restored.render(
        <SlidingPanel open panel="computer" workspace>
          <div />
        </SlidingPanel>,
      ),
    );
    expect(host.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("600");
    expect(storage.getItem("ardurbot:pane-width:computer")).toBeNull();
    expect(storage.getItem("ardurbot:pane-width")).toBe("600");
    await act(async () => press(host.querySelector("hr")!, "ArrowLeft"));
    expect(storage.getItem("ardurbot:pane-width:computer")).toBe("620");
    expect(storage.getItem("ardurbot:pane-width")).toBe("600");

    document.documentElement.dir = "rtl";
    await act(async () =>
      restored.render(
        <SlidingPanel open panel="group-settings" resizeLabel="Change width">
          <div />
        </SlidingPanel>,
      ),
    );
    const rtl = host.querySelector("hr");
    expect(rtl?.getAttribute("aria-label")).toBe("Change width");
    expect(rtl?.getAttribute("aria-valuenow")).toBe("384");
    await act(async () => press(rtl!, "ArrowRight"));
    expect(rtl?.getAttribute("aria-valuenow")).toBe("404");

    await act(async () =>
      restored.render(
        <SlidingPanel open panel="computer" workspace expanded>
          <div />
        </SlidingPanel>,
      ),
    );
    const expanded = host.querySelector("aside");
    expect(expanded?.className).toContain("max-w-none");
    expect(expanded?.className).not.toContain("md:w-(--pane-width)");
    expect(host.querySelector("hr")).toBeNull();
    expect(host.querySelector("[aria-hidden='true']")).toBeNull();

    await act(async () =>
      restored.render(
        <SlidingPanel open={false} panel="settings">
          <div />
        </SlidingPanel>,
      ),
    );
    expect(host.querySelector("hr")).toBeNull();
    await act(async () => restored.unmount());
  } finally {
    document.documentElement.dir = "";
    storage.clear();
    vi.unstubAllGlobals();
  }
});
