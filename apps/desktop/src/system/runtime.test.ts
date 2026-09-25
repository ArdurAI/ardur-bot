import { EventEmitter } from "node:events";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SystemDependencies } from "./controller.js";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  options: null as SystemDependencies | null,
  controller: { openLinksInBrowser: false, shortcuts: { handleInput: vi.fn(() => true) } },
  quick: vi.fn(),
  viewer: vi.fn(),
  external: vi.fn(),
  quit: [] as (() => void)[],
  get: vi.fn(async () => "bot"),
  set: vi.fn(async () => undefined),
}));
vi.mock("electron", () => ({
  app: {
    getPath: () => "/fixture/settings",
    once: (_: string, callback: () => void) => fake.quit.push(callback),
  },
  shell: { openExternal: fake.external },
  ipcMain: {
    handle: (name: string, fn: (...args: unknown[]) => unknown) => fake.handlers.set(name, fn),
    removeHandler: (name: string) => fake.handlers.delete(name),
  },
}));
vi.mock("./install.js", async (original) => ({
  ...(await original<object>()),
  installDesktopSystem: async (options: SystemDependencies) => {
    fake.options = options;
    return { controller: fake.controller };
  },
}));
vi.mock("./windows.js", () => ({
  createQuickAccessWindow: fake.quick,
  openLinkViewer: fake.viewer,
}));
vi.mock("./quick-access.js", async (original) => ({
  ...(await original<object>()),
  QuickAccessStore: class {
    get = fake.get;
    set = fake.set;
  },
}));

import { installSystemRuntime } from "./runtime.js";

function windowAt(url = "https://home.example.invalid/app") {
  const contents = Object.assign(new EventEmitter(), {
    mainFrame: { url },
    session: {},
    send: vi.fn(),
  });
  const window = Object.assign(new EventEmitter(), {
    webContents: contents,
    isDestroyed: () => false,
    show: vi.fn(),
    focus: vi.fn(),
    close: vi.fn(),
    destroy: vi.fn(),
  });
  return {
    window: window as unknown as BrowserWindow,
    contents,
    event: { sender: contents, senderFrame: contents.mainFrame } as unknown as IpcMainInvokeEvent,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  fake.controller.openLinksInBrowser = false;
});
afterEach(() => {
  for (const quit of fake.quit.splice(0)) quit();
  fake.handlers.clear();
});
async function fixture(target: string | null = "https://home.example.invalid") {
  const main = windowAt(),
    quick = windowAt("https://home.example.invalid/desktop/quick-access");
  let current: BrowserWindow | null = main.window;
  fake.quick.mockReturnValue(quick.window);
  const openMain = vi.fn(async () => {
    current = main.window;
    return current;
  });
  const runtime = await installSystemRuntime({
    window: () => current,
    target: () => target,
    openMain,
    preload: "/fixture/preload.cjs",
    mode: () => "new",
    dataFolder: () => null,
    routines: async () => 0,
    menuBar: vi.fn(),
  });
  runtime.attachWindow(main.window, "https://home.example.invalid");
  return {
    main,
    quick,
    runtime,
    openMain,
    setTarget: (value: string) => {
      target = value;
    },
    closeMain: () => {
      current = null;
    },
  };
}
it("opens a compact composer with the existing session even when the main window is closed", async () => {
  const f = await fixture();
  f.closeMain();
  fake.options!.shortcut("quickAccess");
  await vi.waitFor(() => expect(fake.quick).toHaveBeenCalledOnce());
  expect(fake.quick).toHaveBeenCalledWith({
    rendererUrl: "https://home.example.invalid/desktop/quick-access",
    targetUrl: "https://home.example.invalid",
    session: f.main.contents.session,
    preload: "/fixture/preload.cjs",
  });
  expect(f.openMain).not.toHaveBeenCalled();
  expect(
    await fake.handlers.get("desktop.system.quickBot")!(
      f.quick.event,
      { userId: "user", spaceId: "space" },
      "bot",
    ),
  ).toBe("bot");
  expect(fake.set).toHaveBeenCalledWith(
    "https://home.example.invalid",
    { userId: "user", spaceId: "space" },
    "bot",
  );
  await expect(
    fake.handlers.get("desktop.system.quickBot")!(f.main.event, {
      userId: "user",
      spaceId: "space",
    }),
  ).rejects.toThrow("quick access");
});
it("queues voice until the composer listens and handles only the active app's input", async () => {
  const f = await fixture();
  fake.options!.shortcut("voice");
  await vi.waitFor(() => expect(f.openMain).toHaveBeenCalledOnce());
  expect(f.main.contents.send).not.toHaveBeenCalled();
  await fake.handlers.get("desktop.system.shortcutReady")!(f.main.event, true);
  expect(f.main.contents.send).toHaveBeenCalledWith("desktop.system.shortcut", "voice");
  const event = { preventDefault: vi.fn() };
  f.main.contents.emit("before-input-event", event, { key: "d" });
  expect(event.preventDefault).toHaveBeenCalledOnce();
  f.closeMain();
  event.preventDefault.mockClear();
  f.main.contents.emit("before-input-event", event, { key: "d" });
  expect(event.preventDefault).not.toHaveBeenCalled();
});
it("routes links according to the saved preference", async () => {
  const f = await fixture(),
    url = "https://site.example.invalid";
  f.runtime.openLink(url);
  expect(fake.external).toHaveBeenCalledWith(url);
  fake.controller.openLinksInBrowser = true;
  f.runtime.openLink(url);
  expect(fake.viewer).toHaveBeenCalledWith(url);
});

it("accepts composer readiness before startup commits the server and ignores subframe loading", async () => {
  const f = await fixture(null);
  await fake.handlers.get("desktop.system.shortcutReady")!(f.main.event, true);
  f.setTarget("https://home.example.invalid");
  f.main.contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
  f.main.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
  fake.options!.shortcut("voice");
  await vi.waitFor(() =>
    expect(f.main.contents.send).toHaveBeenCalledWith("desktop.system.shortcut", "voice"),
  );
  f.main.contents.send.mockClear();
  f.main.contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
  fake.options!.shortcut("voice");
  await vi.waitFor(() => expect(f.openMain).toHaveBeenCalledTimes(2));
  expect(f.main.contents.send).not.toHaveBeenCalled();
  await fake.handlers.get("desktop.system.shortcutReady")!(f.main.event, true);
  expect(f.main.contents.send).toHaveBeenCalledWith("desktop.system.shortcut", "voice");
});
