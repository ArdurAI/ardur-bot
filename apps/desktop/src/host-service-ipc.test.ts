import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalFolders, localFoldersFile } from "./local-folders.js";

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
  hostServiceIdentity: vi.fn(() => "fixture-registration"),
  hostStorageAvailable: vi.fn(),
  selectedHostRoot: async (path: string) => path,
}));
vi.mock("./tray.js", () => ({ updateHostTray: vi.fn() }));

import { installHostService } from "./host-service-ipc.js";

const LOCAL_ORIGIN = "http://127.0.0.1:40123";
const FOLDER_NOTICE =
  "Bots can read and change files in the folders you add here. Avoid adding folders on shared computers.";
const directories: string[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  fake.handlers.clear();
  fake.keepRunning = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.read.mockResolvedValue({ apiUrl: "https://example.test", hostRoots: [] });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function fixture(
  target = "https://example.test",
  folders = new LocalFolders("/fixture/unused/local-folders.json"),
) {
  const frame = { url: `${target}/app` };
  const window = { webContents: { mainFrame: frame } } as unknown as BrowserWindow;
  const service = installHostService({
    window: () => window,
    target: () => target,
    tray: () => null,
    local: { owns: (url) => new URL(url).origin === LOCAL_ORIGIN, folders },
  });
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  return { event, service, add: fake.handlers.get("desktop.host.addRoot")! };
}
describe("host folder selection", () => {
  it("returns and registers only the folder selected in the native dialog", async () => {
    const f = fixture();
    fake.picker.mockResolvedValue({ canceled: false, filePaths: ["/fixture/approved"] });
    expect(await f.add(f.event, "/fixture/dropped")).toBe("/fixture/approved");
    // The one place the folder sentence is said: macOS shows `message`, others `title`.
    expect(fake.picker.mock.calls[0]?.[1]).toEqual({
      properties: ["openDirectory"],
      title: FOLDER_NOTICE,
      message: FOLDER_NOTICE,
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
    expect(await fake.handlers.get("desktop.host.state")!(event)).toEqual({
      configured: true,
      roots: [],
      unavailable: [],
      registrationId: "fixture-registration",
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

describe("local mode folders", () => {
  async function localFixture() {
    const userData = await mkdtemp(path.join(tmpdir(), "local-folders-"));
    directories.push(userData);
    // A pairing with a team server, made earlier under Existing instance.
    fake.read.mockResolvedValue({
      apiUrl: "https://team.example.test",
      hostRoots: ["/fixture/team-share"],
    });
    const file = localFoldersFile(userData);
    const f = fixture(LOCAL_ORIGIN, new LocalFolders(file));
    const handler = (name: string) => fake.handlers.get(`desktop.host.${name}`)!;
    return { ...f, file, state: () => handler("state")(f.event), handler };
  }

  it("starts with no folders and never lists another server's pairing", async () => {
    const f = await localFixture();
    expect(await f.state()).toEqual({
      configured: false,
      local: true,
      roots: [],
      unavailable: [],
      keepRunning: true,
    });
  });

  it("keeps listing a folder that is gone, marked unavailable, so it can be removed", async () => {
    const f = await localFixture();
    const project = path.join(path.dirname(f.file), "project");
    await mkdir(project);
    fake.picker.mockResolvedValue({ canceled: false, filePaths: [project] });
    await f.add(f.event);
    expect(await f.state()).toMatchObject({ roots: [project], unavailable: [] });
    await rm(project, { recursive: true });
    expect(await f.state()).toMatchObject({ roots: [project], unavailable: [project] });
    await f.handler("removeRoot")(f.event, project);
    expect(await f.state()).toMatchObject({ roots: [], unavailable: [] });
  });

  it("adds the chosen folder to its own private file, and removes it again", async () => {
    const f = await localFixture();
    fake.picker.mockResolvedValue({ canceled: false, filePaths: ["/fixture/projects"] });
    expect(await f.add(f.event)).toBe("/fixture/projects");
    expect(await f.state()).toMatchObject({ local: true, roots: ["/fixture/projects"] });
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual(["/fixture/projects"]);
    expect((await stat(f.file)).mode & 0o777).toBe(0o600);
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();

    await f.handler("removeRoot")(f.event, "/fixture/projects");
    expect(await f.state()).toMatchObject({ roots: [] });
    expect(JSON.parse(await readFile(f.file, "utf8"))).toEqual([]);
  });

  it("does not pair local mode with a host service or keep another pairing running", async () => {
    const f = await localFixture();
    await expect(f.handler("setup")(f.event)).rejects.toThrow("Host service is unavailable here.");
    await f.service.activate(LOCAL_ORIGIN);
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.stop).toHaveBeenCalled();
  });
});
