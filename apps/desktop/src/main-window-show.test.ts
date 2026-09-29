import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import vm from "node:vm";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIN_WINDOW_SHOW_FALLBACK_MS, showMainWindowWhenPainted } from "./main-window-show.js";

type Listener = () => void;

class WindowFake {
  destroyed = false;
  visible = false;
  show = vi.fn(() => {
    this.visible = true;
  });
  focus = vi.fn();
  setBounds = vi.fn();
  setSize = vi.fn();
  setPosition = vi.fn();
  center = vi.fn();
  maximize = vi.fn();
  unmaximize = vi.fn();
  isDestroyed = () => this.destroyed;
  isVisible = () => this.visible;
  listeners = new Map<string, Listener[]>();
  once = (event: string, listener: Listener) => {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
  };
  emit(event: string) {
    if (event === "show") this.visible = true;
    const list = this.listeners.get(event) ?? [];
    this.listeners.set(event, []);
    for (const listener of list) listener();
  }
  handler(event: string) {
    const listener = this.listeners.get(event)?.[0];
    if (!listener) throw new Error(`missing ${event} listener`);
    return listener;
  }
}

const source = readFileSync(new URL("./main.ts", import.meta.url), "utf8");

afterEach(() => {
  vi.useRealTimers();
});

describe("main window first paint", () => {
  it("waits three seconds before showing a window whose first paint never arrives", () => {
    expect(MAIN_WINDOW_SHOW_FALLBACK_MS).toBe(3_000);
    vi.useFakeTimers();
    const win = new WindowFake();
    showMainWindowWhenPainted(win);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(2_999);
    expect(win.show).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    expect(win.setBounds).not.toHaveBeenCalled();
    expect(win.setSize).not.toHaveBeenCalled();
    expect(win.setPosition).not.toHaveBeenCalled();
    expect(win.center).not.toHaveBeenCalled();
    expect(win.maximize).not.toHaveBeenCalled();
    expect(win.unmaximize).not.toHaveBeenCalled();
  });

  it("shows on ready-to-show exactly once and clears the fallback", () => {
    vi.useFakeTimers();
    const win = new WindowFake();
    showMainWindowWhenPainted(win);
    const ready = win.handler("ready-to-show");
    ready();
    ready();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("does not show again when the fallback and ready-to-show both run", () => {
    vi.useFakeTimers();
    const win = new WindowFake();
    showMainWindowWhenPainted(win);
    vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
    win.handler("ready-to-show")();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
  });

  it("clears the fallback when the window is shown or closed first", () => {
    vi.useFakeTimers();
    const shown = new WindowFake();
    showMainWindowWhenPainted(shown);
    shown.visible = true;
    shown.emit("show");
    expect(vi.getTimerCount()).toBe(0);
    shown.handler("ready-to-show")();
    vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
    expect(shown.show).not.toHaveBeenCalled();

    const closed = new WindowFake();
    showMainWindowWhenPainted(closed);
    closed.destroyed = true;
    closed.emit("closed");
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
    expect(closed.show).not.toHaveBeenCalled();
    expect(closed.focus).not.toHaveBeenCalled();
  });

  it("does not show a window that is already destroyed when the fallback fires", () => {
    vi.useFakeTimers();
    const win = new WindowFake();
    win.destroyed = true;
    showMainWindowWhenPainted(win);
    vi.advanceTimersByTime(MAIN_WINDOW_SHOW_FALLBACK_MS);
    expect(win.show).not.toHaveBeenCalled();
    expect(win.focus).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("warm reopen", () => {
  it("shows an existing window immediately for the dock, a second instance, and the tray", () => {
    const activateStart = source.indexOf('  app.on("activate", () => {');
    const activateEnd = source.indexOf("\n  });", activateStart) + "\n  });".length;
    const secondStart = source.indexOf('app.on("second-instance"');
    const secondEnd = source.indexOf("\n});", secondStart) + "\n});".length;
    const trayStart = source.indexOf("  const setMenuBar = (enabled: boolean) => {");
    const trayEnd = source.indexOf("\n  };", trayStart) + "\n  };".length;
    expect(activateStart).toBeGreaterThan(0);
    expect(secondStart).toBeGreaterThan(0);
    expect(trayStart).toBeGreaterThan(0);

    const win = new WindowFake();
    win.visible = true;
    const scheduled = vi.fn();
    const handlers = new Map<string, (...args: unknown[]) => void>();
    const context = {
      app: {
        on: (event: string, handler: (...args: unknown[]) => void) => {
          handlers.set(event, handler);
        },
        emit: (event: string) => {
          handlers.get(event)?.();
        },
      },
      setupWindow: null,
      mainWindow: win,
      clearTimeout: vi.fn(),
      warmWindowTimer: undefined,
      setTimeout: scheduled,
      desktopTray: null as unknown,
      systemTray: (_current: unknown, _enabled: boolean, show: () => void) => {
        context.desktopTray = { show };
        return context.desktopTray;
      },
    };
    vm.runInNewContext(
      stripTypeScriptTypes(
        `${source.slice(activateStart, activateEnd)}\n${source.slice(secondStart, secondEnd)}\n${source.slice(trayStart, trayEnd)}\nthis.setMenuBar = setMenuBar;`,
      ),
      context,
    );
    handlers.get("activate")?.();
    expect(win.show).toHaveBeenCalledOnce();
    expect(win.focus).toHaveBeenCalledOnce();
    expect(scheduled).not.toHaveBeenCalled();

    handlers.get("second-instance")?.({}, ["ardur"]);
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(win.focus).toHaveBeenCalledTimes(2);
    expect(scheduled).not.toHaveBeenCalled();

    (context as typeof context & { setMenuBar: (enabled: boolean) => void }).setMenuBar(true);
    (context.desktopTray as { show: () => void }).show();
    expect(win.show).toHaveBeenCalledTimes(3);
    expect(win.focus).toHaveBeenCalledTimes(3);
    expect(scheduled).not.toHaveBeenCalled();
  });
});

describe("session probe window", () => {
  it("stays hidden, including when it becomes ready to show", async () => {
    const start = source.indexOf("async function defaultSessionHasOriginData");
    const end = source.indexOf("\nfunction createWindow", start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);

    class ProbeWindow {
      static options: Array<Record<string, unknown>> = [];
      static instances: ProbeWindow[] = [];
      shown = 0;
      destroyed = false;
      listeners = new Map<string, Listener[]>();
      webContents = { executeJavaScript: vi.fn(async () => false) };
      constructor(options: Record<string, unknown>) {
        ProbeWindow.options.push(options);
        ProbeWindow.instances.push(this);
      }
      show() {
        this.shown += 1;
      }
      focus() {
        this.shown += 1;
      }
      once(event: string, listener: Listener) {
        const list = this.listeners.get(event) ?? [];
        list.push(listener);
        this.listeners.set(event, list);
      }
      loadURL = vi.fn(async () => {
        for (const listener of this.listeners.get("ready-to-show") ?? []) listener();
      });
      isDestroyed() {
        return this.destroyed;
      }
      destroy() {
        this.destroyed = true;
      }
    }

    const context = {
      BrowserWindow: ProbeWindow,
      liveProbeWindows: 0,
    };
    vm.runInNewContext(
      `${stripTypeScriptTypes(source.slice(start, end))}\nthis.probe = defaultSessionHasOriginData;`,
      context,
    );
    const found = await (
      context as typeof context & { probe: (origin: string) => Promise<boolean> }
    ).probe("https://app.example.test");
    const probe = ProbeWindow.options;
    expect(found).toBe(false);
    expect(probe).toHaveLength(1);
    expect(probe[0]).toMatchObject({ show: false, width: 1, height: 1 });
    expect(ProbeWindow.instances[0]!.shown).toBe(0);
    expect(ProbeWindow.instances[0]!.destroyed).toBe(true);
    expect(context.liveProbeWindows).toBe(0);
  });
});

describe("local server settings window", () => {
  it("opens immediately instead of waiting for the main window's first paint", () => {
    const titleAt = source.indexOf('title: "Local Server Settings"');
    const start = source.lastIndexOf("new BrowserWindow({", titleAt);
    const end = source.indexOf("webPreferences:", titleAt);
    const block = source.slice(start, end);
    const spread = block.indexOf("browserWindowOptions");
    const shown = block.indexOf("show: true");
    expect(spread).toBeGreaterThan(-1);
    expect(shown).toBeGreaterThan(spread);
  });
});
