import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, () => void>(),
  register: vi.fn(() => true),
  unregister: vi.fn(),
  start: vi.fn(() => 2),
  stop: vi.fn(),
  saved: {
    runOnStartup: false,
    quickAccess: "Off",
    voice: "Off",
    dictation: "Off",
    menuBar: false,
    keepAwake: false,
    openLinksInBrowser: false,
  },
}));
vi.mock("electron", () => ({
  app: {
    getPath: () => "/fixture/settings",
    getVersion: () => "0.1.0",
    getLoginItemSettings: () => ({ openAtLogin: false }),
    once: (name: string, callback: () => void) => fake.listeners.set(name, callback),
    removeListener: (name: string) => fake.listeners.delete(name),
  },
  globalShortcut: { register: fake.register, unregister: fake.unregister },
  powerSaveBlocker: { start: fake.start, stop: fake.stop },
  systemPreferences: {
    isTrustedAccessibilityClient: () => false,
    getMediaAccessStatus: () => "not-determined",
  },
  shell: { openExternal: vi.fn() },
  ipcMain: {
    handle: (name: string, handler: (...args: unknown[]) => unknown) =>
      fake.handlers.set(name, handler),
    removeHandler: (name: string) => fake.handlers.delete(name),
  },
}));
vi.mock("./store.js", () => ({
  SystemStore: class {
    read = async () => ({ ...fake.saved });
    write = async () => undefined;
  },
}));

import { installDesktopSystem, systemSenderAllowed } from "./install.js";

beforeEach(() => {
  vi.clearAllMocks();
  fake.handlers.clear();
  fake.listeners.clear();
});

function trusted() {
  const frame = { url: "https://home.example.invalid/" };
  const contents = { mainFrame: frame };
  return {
    window: { isDestroyed: () => false, webContents: contents } as unknown as BrowserWindow,
    event: { sender: contents, senderFrame: frame } as unknown as IpcMainInvokeEvent,
  };
}
it("authorizes only the active main frame at its configured origin", () => {
  const f = trusted();
  const target = "https://home.example.invalid";
  expect(systemSenderAllowed(f.event, f.window, target)).toBe(true);
  expect(systemSenderAllowed(f.event, null, target)).toBe(false);
  expect(systemSenderAllowed(f.event, f.window, null)).toBe(false);
  expect(systemSenderAllowed(f.event, f.window, "https://outside.example.invalid")).toBe(false);
  expect(
    systemSenderAllowed(
      { ...f.event, senderFrame: { url: f.event.senderFrame.url } } as IpcMainInvokeEvent,
      f.window,
      target,
    ),
  ).toBe(false);
  expect(
    systemSenderAllowed({ ...f.event, sender: {} } as IpcMainInvokeEvent, f.window, target),
  ).toBe(false);
});
it("cleans up its registered keys, blocker, handlers and timer on quit", async () => {
  vi.useFakeTimers();
  const f = trusted();
  const installed = await installDesktopSystem({
    window: () => f.window,
    target: () => "https://home.example.invalid",
    mode: () => "new",
    dataFolder: () => null,
    routines: async () => 2,
    shortcut: vi.fn(),
    menuBar: vi.fn(),
  });
  try {
    await fake.handlers.get("desktop.system.set")!(f.event, "keepAwake", true);
    await fake.handlers.get("desktop.system.set")!(f.event, "quickAccess", "Alt+Space");
    expect(fake.start).toHaveBeenCalledWith("prevent-app-suspension");
    expect(fake.handlers.size).toBe(4);
    expect(() =>
      fake.handlers.get("desktop.system.set")!({ sender: {} }, "keepAwake", true),
    ).toThrow("Open System settings");
    fake.listeners.get("will-quit")!();
    expect(fake.stop).toHaveBeenCalledWith(2);
    expect(fake.unregister).toHaveBeenCalledWith("Alt+Space");
    expect(fake.handlers.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    installed.dispose();
    vi.useRealTimers();
  }
});
