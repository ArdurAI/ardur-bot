import type { BrowserWindow, IpcMainInvokeEvent, Tray, WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: IpcMainInvokeEvent, value?: unknown) => unknown>(),
  setBadgeCount: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { setBadgeCount: fake.setBadgeCount },
  ipcMain: {
    handle: (name: string, handler: (event: IpcMainInvokeEvent, value?: unknown) => unknown) => {
      fake.handlers.set(name, handler);
    },
  },
}));

import { installDockBadge, validBadgeCount } from "./dock-badge.js";

const originalPlatform = process.platform;

function usePlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

beforeEach(() => {
  vi.clearAllMocks();
  fake.handlers.clear();
});

afterEach(() => {
  usePlatform(originalPlatform);
});

type Navigation = (event: { isMainFrame: boolean; isSameDocument: boolean }) => void;

function page(url: string) {
  const frame = { url: `${url}/app` };
  let destroyed = false;
  let navigation: Navigation = () => undefined;
  const contents = {
    mainFrame: frame,
    on: (_event: string, listener: Navigation) => {
      navigation = listener;
    },
  };
  const window = {
    isDestroyed: () => destroyed,
    webContents: contents,
  } as unknown as BrowserWindow;
  return {
    frame,
    contents,
    window,
    destroy() {
      destroyed = true;
    },
    emitNavigation(event: { isMainFrame: boolean; isSameDocument: boolean }) {
      navigation(event);
    },
  };
}

function menuTray() {
  return { isDestroyed: () => false, setTitle: vi.fn() };
}

function install(platform: NodeJS.Platform, options?: { url?: string; tray?: boolean }) {
  usePlatform(platform);
  const url = options?.url ?? "https://app.example.test";
  const open = page(url);
  const tray = menuTray();
  let shown: BrowserWindow | null = open.window;
  let menu: Tray | null = options?.tray === false ? null : (tray as unknown as Tray);
  const badge = installDockBadge({
    window: () => shown,
    tray: () => menu,
  });
  badge.attach(open.contents as unknown as WebContents, url);
  const handler = fake.handlers.get("desktop.dock.waiting")!;
  const deliver = (
    source: { contents: { mainFrame: { url: string } }; frame: { url: string } },
    value: unknown,
    event?: Partial<IpcMainInvokeEvent>,
  ) =>
    handler(
      {
        sender: source.contents,
        senderFrame: source.frame,
        ...event,
      } as IpcMainInvokeEvent,
      value,
    );
  return {
    ...open,
    tray,
    url,
    setBadgeCount: fake.setBadgeCount,
    sync: badge.sync,
    attach: badge.attach,
    show(window: BrowserWindow | null) {
      shown = window;
    },
    useTray(enabled: boolean) {
      menu = enabled ? (tray as unknown as Tray) : null;
    },
    send(value: unknown, event?: Partial<IpcMainInvokeEvent>) {
      return deliver(open, value, event);
    },
    sendFrom(
      source: { contents: { mainFrame: { url: string } }; frame: { url: string } },
      value: unknown,
      event?: Partial<IpcMainInvokeEvent>,
    ) {
      return deliver(source, value, event);
    },
  };
}

describe("dock badge", () => {
  it("accepts only a whole number from 0 to 999", () => {
    expect(validBadgeCount(0)).toBe(true);
    expect(validBadgeCount(999)).toBe(true);
    for (const value of [1.5, -1, 1000, "3", Number.NaN, null, undefined, {}, true]) {
      expect(validBadgeCount(value)).toBe(false);
    }
  });

  it("sets and clears the badge from count updates", async () => {
    const dock = install("darwin");
    expect(dock.setBadgeCount).toHaveBeenCalledExactlyOnceWith(0);
    dock.setBadgeCount.mockClear();
    dock.tray.setTitle.mockClear();
    await dock.send(2);
    await dock.send(0);
    expect(dock.setBadgeCount.mock.calls.map(([count]) => count)).toEqual([2, 0]);
    expect(dock.tray.setTitle.mock.calls.map(([title]) => title)).toEqual(["2", ""]);
    dock.setBadgeCount.mockClear();
    dock.emitNavigation({ isMainFrame: true, isSameDocument: true });
    dock.emitNavigation({ isMainFrame: false, isSameDocument: false });
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
    dock.emitNavigation({ isMainFrame: true, isSameDocument: false });
    expect(dock.setBadgeCount).toHaveBeenCalledExactlyOnceWith(0);
    expect(dock.tray.setTitle).toHaveBeenLastCalledWith("");
  });

  it("shows a count that arrives before the window is attached", async () => {
    usePlatform("darwin");
    const open = page("https://app.example.test");
    const tray = menuTray();
    const badge = installDockBadge({
      window: () => open.window,
      tray: () => tray as unknown as Tray,
    });
    const handler = fake.handlers.get("desktop.dock.waiting")!;
    await handler({ sender: open.contents, senderFrame: open.frame } as IpcMainInvokeEvent, 2);
    expect(fake.setBadgeCount).not.toHaveBeenCalled();
    badge.attach(open.contents as unknown as WebContents, "https://app.example.test");
    expect(fake.setBadgeCount).toHaveBeenCalledExactlyOnceWith(2);
    expect(tray.setTitle).toHaveBeenCalledExactlyOnceWith("2");
  });

  it("drops a queued count from a different server", async () => {
    usePlatform("darwin");
    const open = page("https://evil.example.test");
    const badge = installDockBadge({
      window: () => open.window,
      tray: () => null,
    });
    const handler = fake.handlers.get("desktop.dock.waiting")!;
    await handler({ sender: open.contents, senderFrame: open.frame } as IpcMainInvokeEvent, 2);
    badge.attach(open.contents as unknown as WebContents, "https://app.example.test");
    expect(fake.setBadgeCount).toHaveBeenCalledExactlyOnceWith(0);
  });

  it("shows the new server's count from that window's own address", async () => {
    const dock = install("darwin", { url: "https://old.example.test" });
    await dock.send(1);
    const next = page("https://new.example.test");
    dock.show(next.window);
    dock.attach(next.contents as unknown as WebContents, "https://new.example.test");
    dock.setBadgeCount.mockClear();
    dock.tray.setTitle.mockClear();
    await dock.sendFrom(next, 2);
    expect(dock.setBadgeCount).toHaveBeenCalledExactlyOnceWith(2);
    expect(dock.tray.setTitle).toHaveBeenCalledExactlyOnceWith("2");
  });

  it("puts the previous window's count back after a failed switch", async () => {
    const dock = install("darwin");
    await dock.send(2);
    const next = page("https://new.example.test");
    dock.show(next.window);
    dock.attach(next.contents as unknown as WebContents, "https://new.example.test");
    expect(dock.setBadgeCount).toHaveBeenLastCalledWith(0);
    expect(dock.tray.setTitle).toHaveBeenLastCalledWith("");
    dock.show(dock.window);
    dock.sync();
    expect(dock.setBadgeCount).toHaveBeenLastCalledWith(2);
    expect(dock.tray.setTitle).toHaveBeenLastCalledWith("2");
  });

  it("shows the count when the menu bar icon appears later", async () => {
    const dock = install("darwin", { tray: false });
    await dock.send(4);
    expect(dock.tray.setTitle).not.toHaveBeenCalled();
    expect(dock.setBadgeCount).toHaveBeenLastCalledWith(4);
    dock.useTray(true);
    dock.sync();
    expect(dock.tray.setTitle).toHaveBeenCalledExactlyOnceWith("4");
  });

  it("ignores invalid counts and untrusted senders", async () => {
    const dock = install("darwin");
    dock.setBadgeCount.mockClear();
    for (const value of [1.5, -1, 1000, "3", Number.NaN, null, undefined]) {
      await dock.send(value);
    }
    await dock.send(4, { sender: {} as IpcMainInvokeEvent["sender"] });
    await dock.send(4, {
      senderFrame: { url: dock.frame.url } as IpcMainInvokeEvent["senderFrame"],
    });
    dock.frame.url = "https://evil.example.test/app";
    await dock.send(4);
    dock.frame.url = "https://app.example.test/app";
    dock.destroy();
    await dock.send(4);
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
    dock.attach(dock.contents as unknown as WebContents, "not a url");
    dock.setBadgeCount.mockClear();
    await dock.send(4);
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
    dock.attach(dock.contents as unknown as WebContents, "https://app.example.test");
    dock.setBadgeCount.mockClear();
    await dock.send(999);
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("does nothing on %s", async (platform) => {
    const dock = install(platform);
    await dock.send(3);
    await dock.send(0);
    dock.emitNavigation({ isMainFrame: true, isSameDocument: false });
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
    expect(dock.tray.setTitle).not.toHaveBeenCalled();
  });
});
