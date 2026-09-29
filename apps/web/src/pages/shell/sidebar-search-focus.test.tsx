// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, type ReactNode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeBotsSidebarCollapsed } from "../../lib/bots-sidebar-pref";
import {
  botsSidebarCollapsedForPage,
  sidebarSearchFocusRequested,
  useSidebarSearchFocus,
} from "./sidebar-search-focus";

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
let mounts = 0;

function Page({ name, dashboard, userId }: { name: string; dashboard: boolean; userId: string }) {
  const location = useLocation();
  const [collapsed, setCollapsed] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [ready, setReady] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    mounts += 1;
  }, []);
  // The saved preference is applied before search focus, matching the shell.
  useEffect(() => {
    const stored = window.localStorage.getItem(`ardurbot:bots-sidebar-collapsed:${userId}`) === "1";
    const requested = sidebarSearchFocusRequested(location.state);
    setCollapsed(botsSidebarCollapsedForPage(stored, requested, dashboard));
    if (requested && !dashboard && stored) writeBotsSidebarCollapsed(userId, false);
    setReady(true);
  }, [userId, dashboard, location.state]);
  const request = useSidebarSearchFocus({
    dashboard,
    hidden: collapsed && !drawer,
    ready,
    reveal: () => {
      if (window.matchMedia("(max-width: 767px)").matches) setDrawer(true);
      else {
        setCollapsed(false);
        writeBotsSidebarCollapsed(userId, false);
      }
    },
    inputRef,
  });
  return (
    <div>
      <p data-testid="page">{name}</p>
      <button
        type="button"
        onClick={() => {
          if (dashboard) writeBotsSidebarCollapsed(userId, false);
          request();
        }}
      >
        Find
      </button>
      <input
        aria-label="Space search"
        ref={inputRef}
        data-collapsed={collapsed ? "1" : "0"}
        data-drawer={drawer ? "1" : "0"}
      />
    </div>
  );
}

function render(
  initial: string | { pathname: string; state: unknown },
  routes: ReactNode,
  key = "router",
) {
  return act(async () => {
    root.render(
      <MemoryRouter key={key} initialEntries={[initial]}>
        <Routes>{routes}</Routes>
      </MemoryRouter>,
    );
  });
}

function BoardShell() {
  return <Page name="board" dashboard userId="user" />;
}
function BotsShell() {
  return <Page name="bots" dashboard={false} userId="user" />;
}

const search = () => container.querySelector("input")!;

function installStorage() {
  const entries = new Map<string, string>();
  const storage = {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => {
      entries.set(key, value);
    },
    removeItem: (key: string) => {
      entries.delete(key);
    },
    clear: () => entries.clear(),
    key: (index: number) => [...entries.keys()][index] ?? null,
    get length() {
      return entries.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  Object.defineProperty(window, "localStorage", { value: storage, configurable: true });
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mounts = 0;
  installStorage();
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() {
      return false;
    },
    onchange: null,
  })) as typeof window.matchMedia;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) await act(async () => root.unmount());
  container?.remove();
});

describe("sidebar search focus", () => {
  it("opens a collapsed bots list when the new page is asked to focus search", () => {
    expect(sidebarSearchFocusRequested({ focusSidebarSearch: true })).toBe(true);
    expect(sidebarSearchFocusRequested(null)).toBe(false);
    expect(sidebarSearchFocusRequested({ focusSidebarSearch: false })).toBe(false);
    expect(botsSidebarCollapsedForPage(true, true, false)).toBe(false);
    expect(botsSidebarCollapsedForPage(true, true, true)).toBe(true);
    expect(botsSidebarCollapsedForPage(false, false, false)).toBe(false);
  });

  it("focuses search after the Board shell is gone", async () => {
    writeBotsSidebarCollapsed("user", true);
    await render("/app/board", [
      <Route key="board" path="/app/board" element={<BoardShell />} />,
      <Route key="bots" path="/app/bots" element={<BotsShell />} />,
    ]);
    expect(mounts).toBe(1);
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.querySelector("[data-testid=page]")!.textContent).toBe("bots");
    expect(mounts).toBe(2);
    expect(search()).toBe(document.activeElement);
    expect(search().getAttribute("data-collapsed")).toBe("0");
    expect(localStorage.getItem("ardurbot:bots-sidebar-collapsed:user")).toBeNull();
  });

  it("focuses search when the history entry asks, even if the list was saved closed", async () => {
    writeBotsSidebarCollapsed("user", true);
    await render({ pathname: "/app/bots", state: { focusSidebarSearch: true } }, [
      <Route
        key="bots"
        path="/app/bots"
        element={<Page name="bots" dashboard={false} userId="user" />}
      />,
    ]);
    expect(search()).toBe(document.activeElement);
    expect(search().getAttribute("data-collapsed")).toBe("0");
    expect(localStorage.getItem("ardurbot:bots-sidebar-collapsed:user")).toBeNull();
  });

  it("focuses search on the bots page without leaving it, including a narrow drawer", async () => {
    writeBotsSidebarCollapsed("user", true);
    await render("/app/bots", [
      <Route
        key="bots"
        path="/app/bots"
        element={<Page name="bots" dashboard={false} userId="user" />}
      />,
    ]);
    expect(search()).not.toBe(document.activeElement);
    expect(search().getAttribute("data-collapsed")).toBe("1");
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.querySelector("[data-testid=page]")!.textContent).toBe("bots");
    expect(search()).toBe(document.activeElement);
    expect(search().getAttribute("data-collapsed")).toBe("0");

    writeBotsSidebarCollapsed("user", true);
    window.matchMedia = ((query: string) => ({
      matches: query.includes("767px"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent() {
        return false;
      },
      onchange: null,
    })) as typeof window.matchMedia;
    await render(
      "/app/bots",
      [
        <Route
          key="narrow"
          path="/app/bots"
          element={<Page name="narrow" dashboard={false} userId="user" />}
        />,
      ],
      "narrow",
    );
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(search()).toBe(document.activeElement);
    expect(search().getAttribute("data-drawer")).toBe("1");
    expect(search().getAttribute("data-collapsed")).toBe("1");
  });

  it("keeps the request when the overview shell is reused on the way to the bots list", async () => {
    writeBotsSidebarCollapsed("user", true);
    await render("/app", [
      <Route
        key="overview"
        path="/app"
        element={<Page name="overview" dashboard userId="user" />}
      />,
      <Route
        key="bots"
        path="/app/bots"
        element={<Page name="bots" dashboard={false} userId="user" />}
      />,
    ]);
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(mounts).toBe(1);
    expect(container.querySelector("[data-testid=page]")!.textContent).toBe("bots");
    expect(search()).toBe(document.activeElement);
    expect(search().getAttribute("data-collapsed")).toBe("0");
  });

  it("wires the shell so Board search survives the route change", () => {
    const source = readFileSync(join(process.cwd(), "apps/web/src/pages/Shell.tsx"), "utf8");
    const hook = readFileSync(
      join(process.cwd(), "apps/web/src/pages/shell/sidebar-search-focus.ts"),
      "utf8",
    );
    expect(source).toContain("useSidebarSearchFocus");
    expect(source).toContain("requestSidebarSearch()");
    expect(source).toContain("botsSidebarCollapsedForPage");
    expect(source).toContain("ready: sidebarPrefReady");
    expect(source).not.toContain("sidebarSearchPending");
    // The history entry, not the Board shell, carries the request across the route change.
    expect(hook).toContain("focusSidebarSearch: true");
  });
});
