// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { WindowChrome } from "./WindowChrome";

const platform = vi.hoisted(() => ({ value: "darwin" }));
vi.mock("../lib/desktop", () => ({
  desktopBridge: () => ({}),
  windowChromeKind: () => platform.value,
}));
vi.mock("./shell/TopNav", () => ({ TopNav: () => <nav>Dashboard Bots Board</nav> }));
afterEach(() => vi.unstubAllGlobals());
it.each(["darwin", "win32", "linux", "browser"])(
  "renders navigation on %s, reserving only the macOS traffic light space",
  async (os) => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    platform.value = os;
    const node = document.createElement("div");
    const root = createRoot(node);
    await act(async () => root.render(<WindowChrome navigation />));
    expect(node.querySelector("nav")?.textContent).toBe("Dashboard Bots Board");
    expect(Boolean(node.querySelector('[aria-hidden="true"]'))).toBe(os === "darwin");
    expect(node.querySelector("button")).toBeNull();
    await act(async () => root.unmount());
  },
);
