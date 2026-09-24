import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
  read: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  keepRunning: true,
  saveLifecycle: vi.fn(),
  picker: vi.fn(),
}));
vi.mock("electron", () => ({
  app: { getPath: () => "/fixture", getAppPath: () => "/fixture", isPackaged: false },
  safeStorage: {},
  dialog: { showOpenDialog: fake.picker },
  ipcMain: {
    handle: (name: string, handler: (event: unknown, value?: unknown) => Promise<unknown>) =>
      fake.handlers.set(name, handler),
  },
}));
vi.mock("./host-service.js", () => ({
  HostLifecyclePreferences: class {
    load = async () => undefined;
    get keepRunning() {
      return fake.keepRunning;
    }
    async setKeepRunning(value: boolean) {
      await fake.saveLifecycle(value);
      fake.keepRunning = value;
    }
  },
  HostServiceStore: class {
    read = fake.read;
    write = fake.write;
  },
  HostServiceSupervisor: class {
    start = fake.start;
    stop = fake.stop;
  },
  hostServiceLaunch: vi.fn(),
  hostStorageAvailable: vi.fn(),
  selectedHostRoot: async (path: string) => path,
}));
vi.mock("./tray.js", () => ({ updateHostTray: vi.fn() }));

import { installHostService } from "./host-service-ipc.js";

beforeEach(() => {
  vi.clearAllMocks();
  fake.handlers.clear();
  fake.keepRunning = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.read.mockResolvedValue({ apiUrl: "https://example.test", hostRoots: [] });
});
afterEach(() => vi.restoreAllMocks());
function fixture() {
  const frame = { url: "https://example.test/app" };
  const window = { webContents: { mainFrame: frame } } as unknown as BrowserWindow;
  const service = installHostService({
    window: () => window,
    target: () => "https://example.test",
    tray: () => null,
  });
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { event, service, add: fake.handlers.get("desktop.host.addRoot")! };
}
describe("host folder selection", () => {
  it("returns and registers only the folder selected in the native dialog", async () => {
    const f = fixture();
    fake.picker.mockResolvedValue({ canceled: false, filePaths: ["/fixture/approved"] });
    expect(await f.add(f.event, "/fixture/dropped")).toBe("/fixture/approved");
    expect(fake.picker.mock.calls[0]?.[1]).toEqual({
      properties: ["openDirectory"],
      defaultPath: "/fixture/dropped",
    });
    expect(fake.write).toHaveBeenCalledWith({
      apiUrl: "https://example.test",
      hostRoots: ["/fixture/approved"],
    });
    expect(fake.start).toHaveBeenCalledOnce();
  });
  it("does not register anything after cancellation or an untrusted renderer", async () => {
    const f = fixture();
    fake.picker.mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await f.add(f.event)).toBeNull();
    await expect(
      f.add({ ...f.event, senderFrame: { url: "https://other.test" } }),
    ).resolves.toEqual({ error: "Host service is unavailable here." });
    expect(fake.write).not.toHaveBeenCalled();
  });
  it("authorizes and validates lifecycle changes before stopping the host with its window", async () => {
    const { event, service } = fixture();
    const setKeepRunning = fake.handlers.get("desktop.host.setKeepRunning")!;
    service.windowClosed();
    expect(fake.stop).not.toHaveBeenCalled();
    await expect(setKeepRunning(event, "false")).rejects.toThrow();
    await expect(
      setKeepRunning({ ...event, senderFrame: { url: "https://other.test" } }, false),
    ).rejects.toThrow();
    expect(fake.saveLifecycle).not.toHaveBeenCalled();
    await setKeepRunning(event, false);
    expect(fake.saveLifecycle).toHaveBeenCalledWith(false);
    expect(await fake.handlers.get("desktop.host.state")!(event)).toMatchObject({
      keepRunning: false,
    });
    expect(service.keepRunning).toBe(false);
    service.windowClosed();
    expect(fake.stop).toHaveBeenCalledOnce();
  });
});

it("logs an underlying folder error once and returns only a safe reason to preload", async () => {
  const f = fixture();
  const failure = new Error("Set up this computer first.");
  fake.read.mockRejectedValueOnce(failure);
  await expect(f.add(f.event)).resolves.toEqual({ error: failure.message });
  expect(console.error).toHaveBeenCalledExactlyOnceWith("Could not add folder.", failure);
  fake.read.mockRejectedValueOnce(new Error("private storage details"));
  await expect(f.add(f.event)).resolves.toEqual({ error: "Could not add folder. Try again." });
});
