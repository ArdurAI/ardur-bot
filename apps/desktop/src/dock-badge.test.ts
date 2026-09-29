import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

beforeEach(() => {
  vi.clearAllMocks();
  fake.handlers.clear();
});

function install(platform: string, setBadgeCount = vi.fn()) {
  const frame = { url: "https://app.example.test/app" };
  let target = "https://app.example.test";
  let navigation: (event: { isMainFrame: boolean; isSameDocument: boolean }) => void = () =>
    undefined;
  const contents = {
    mainFrame: frame,
    on: (
      event: string,
      listener: (details: { isMainFrame: boolean; isSameDocument: boolean }) => void,
    ) => {
      if (event === "did-start-navigation") navigation = listener;
    },
  };
  const window = {
    isDestroyed: () => false,
    webContents: contents,
  } as unknown as BrowserWindow;
  installDockBadge({
    window: () => window,
    target: () => target,
    platform,
    setBadgeCount,
  }).attach(contents as unknown as WebContents);
  const handler = fake.handlers.get("desktop.dock.waiting")!;
  return {
    frame,
    contents,
    setBadgeCount,
    setTarget(value: string) {
      target = value;
    },
    emitNavigation(event: { isMainFrame: boolean; isSameDocument: boolean }) {
      navigation(event);
    },
    send(value: unknown, event?: Partial<IpcMainInvokeEvent>) {
      return handler(
        {
          sender: contents,
          senderFrame: frame,
          ...event,
        } as IpcMainInvokeEvent,
        value,
      );
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
    await dock.send(2);
    await dock.send(0);
    expect(dock.setBadgeCount.mock.calls.map(([count]) => count)).toEqual([2, 0]);
    dock.setBadgeCount.mockClear();
    dock.emitNavigation({ isMainFrame: true, isSameDocument: true });
    dock.emitNavigation({ isMainFrame: false, isSameDocument: false });
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
    dock.emitNavigation({ isMainFrame: true, isSameDocument: false });
    expect(dock.setBadgeCount).toHaveBeenCalledExactlyOnceWith(0);
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
    dock.setTarget("not a url");
    expect(await dock.send(4)).toBeUndefined();
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
    dock.setTarget("https://app.example.test");
    await dock.send(999);
    expect(dock.setBadgeCount).toHaveBeenCalledExactlyOnceWith(999);
  });

  it.each(["linux", "win32"])("does nothing on %s", async (platform) => {
    const dock = install(platform);
    await dock.send(3);
    await dock.send(0);
    dock.emitNavigation({ isMainFrame: true, isSameDocument: false });
    expect(dock.setBadgeCount).not.toHaveBeenCalled();
  });

  it("uses the macOS dock badge when the app provides it", async () => {
    const frame = { url: "https://app.example.test/app" };
    const contents = { mainFrame: frame };
    const window = {
      isDestroyed: () => false,
      webContents: contents,
    } as unknown as BrowserWindow;
    installDockBadge({
      window: () => window,
      target: () => "https://app.example.test",
      platform: "darwin",
    });
    await fake.handlers.get("desktop.dock.waiting")!(
      { sender: contents, senderFrame: frame } as IpcMainInvokeEvent,
      1,
    );
    expect(fake.setBadgeCount).toHaveBeenCalledExactlyOnceWith(1);
  });
});
