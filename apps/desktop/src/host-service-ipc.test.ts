import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, value?: unknown) => Promise<unknown>>(),
  read: vi.fn(),
  write: vi.fn(),
  start: vi.fn(),
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
  HostServiceStore: class {
    read = fake.read;
    write = fake.write;
  },
  HostServiceSupervisor: class {
    start = fake.start;
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
  fake.read.mockResolvedValue({ apiUrl: "https://example.test", hostRoots: [] });
});
function fixture() {
  const frame = { url: "https://example.test/app" };
  const window = { webContents: { mainFrame: frame } } as unknown as BrowserWindow;
  installHostService({
    window: () => window,
    target: () => "https://example.test",
    tray: () => null,
  });
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { event, add: fake.handlers.get("desktop.host.addRoot")! };
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
    ).rejects.toThrow();
    expect(fake.write).not.toHaveBeenCalled();
  });
});
