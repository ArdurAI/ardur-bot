// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SlidingPanel } from "./sliding-panel.js";

let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let measure: ResizeObserverCallback;
let mediaChange: () => void;
let narrow = false;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  narrow = false;
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: ResizeObserverCallback) {
        measure = callback;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal("matchMedia", () => ({
    get matches() {
      return narrow;
    },
    addEventListener: (_: string, callback: () => void) => {
      mediaChange = callback;
    },
    removeEventListener: () => {},
  }));
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
  document.dir = "";
});
const size = async (width: number, height = 800) =>
  act(async () =>
    measure([{ contentRect: { width, height } } as ResizeObserverEntry], {} as ResizeObserver),
  );

it("uses the row's real maximum for the keyboard handle and restores width after shrinking", async () => {
  const change = vi.fn();
  await act(async () =>
    root.render(
      <SlidingPanel open panel="computer" workspace width={700} onWidthChange={change}>
        <textarea defaultValue="draft" />
      </SlidingPanel>,
    ),
  );
  const body = host.querySelector("textarea");
  await size(1000);
  expect(host.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("600");
  expect(host.querySelector("hr")?.getAttribute("aria-valuemax")).toBe("600");
  await act(async () =>
    host
      .querySelector("hr")!
      .dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })),
  );
  expect(change).toHaveBeenCalledWith(600);
  await size(700);
  expect(host.querySelector("aside")?.dataset.overlay).toBe("true");
  expect(host.querySelector("hr")).toBeNull();
  await size(1400);
  expect(host.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("700");
  expect(host.querySelector("textarea")).toBe(body);
  expect(change).toHaveBeenCalledTimes(1);
});
it("retains hidden bodies for Back to chat and moves the split without remounting", async () => {
  const render = async (open: boolean, position: "right" | "left" | "bottom", expanded = false) =>
    act(async () =>
      root.render(
        <SlidingPanel
          open={open}
          panel="computer"
          workspace
          width={620}
          height={300}
          position={position}
          expanded={expanded}
          keepMounted
        >
          <textarea defaultValue="draft" />
        </SlidingPanel>,
      ),
    );
  await render(true, "right");
  const body = host.querySelector("textarea");
  await render(true, "left");
  expect(host.querySelector("aside")?.className).toContain("start-0");
  expect(host.querySelector('[aria-hidden="true"]')?.className).toContain("order-first");
  await render(true, "bottom");
  expect(host.querySelector("hr")?.getAttribute("aria-orientation")).toBe("horizontal");
  expect(host.querySelector("hr")?.getAttribute("aria-valuenow")).toBe("300");
  await render(true, "bottom", true);
  expect(host.querySelector("hr")).toBeNull();
  await render(false, "right");
  expect(host.querySelector("aside")?.hasAttribute("inert")).toBe(true);
  expect(host.querySelector("textarea")).toBe(body);
  await render(true, "right");
  expect(host.querySelector("textarea")).toBe(body);
});
it("reacts to the narrow media query without writing desktop width", async () => {
  const onOverlay = vi.fn();
  const change = vi.fn();
  await act(async () =>
    root.render(
      <SlidingPanel
        open
        panel="computer"
        workspace
        width={640}
        onOverlayChange={onOverlay}
        onWidthChange={change}
      >
        <div />
      </SlidingPanel>,
    ),
  );
  narrow = true;
  await act(async () => mediaChange());
  expect(host.querySelector("aside")?.dataset.overlay).toBe("true");
  expect(onOverlay).toHaveBeenLastCalledWith(true);
  expect(change).not.toHaveBeenCalled();
  expect(mediaChange).toBeTypeOf("function");
});
