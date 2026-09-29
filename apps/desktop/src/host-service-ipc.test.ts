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
  clear: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  storageAvailable: true,
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
    clear = fake.clear;
  },
  HostServiceSupervisor: class {
    start = fake.start;
    stop = fake.stop;
  },
  hostServiceLaunch: vi.fn(),
  hostServiceIdentity: vi.fn(() => "fixture-registration"),
  hostStorageAvailable: vi.fn(() => fake.storageAvailable),
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
  fake.storageAvailable = true;
  vi.spyOn(console, "error").mockImplementation(() => {});
  fake.read.mockResolvedValue({ apiUrl: "https://example.test", hostRoots: [] });
});
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
function fixture(
  target = "https://example.test",
  folders = new LocalFolders("/fixture/unused/local-folders.json"),
) {
  let currentTarget = target;
  const frame = { url: `${target}/app` };
  const sessionFetch = vi.fn();
  const window = {
    webContents: { mainFrame: frame, session: { fetch: sessionFetch } },
  } as unknown as BrowserWindow;
  const service = installHostService({
    window: () => window,
    target: () => currentTarget,
    tray: () => null,
    local: { owns: (url) => new URL(url).origin === LOCAL_ORIGIN, folders },
  });
  const event = { sender: window.webContents, senderFrame: frame } as unknown as IpcMainInvokeEvent;
  const handler = (name: string) => fake.handlers.get(`desktop.host.${name}`)!;
  return {
    event,
    service,
    fetch: sessionFetch,
    handler,
    changeTarget: (next: string) => {
      currentTarget = next;
    },
    add: fake.handlers.get("desktop.host.addRoot")!,
  };
}

const PAIR_TOKEN = "a".repeat(43);

describe("saved host pairing activation", () => {
  it("restores a pairing after the matching window becomes active", async () => {
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("REALTIME_DATABASE_URL", "");
    vi.stubEnv("SANDBOX_SUPERVISOR_URL", "");
    const f = fixture();
    await f.service.activate("https://example.test");
    expect(fake.start).toHaveBeenCalledExactlyOnceWith({
      apiUrl: "https://example.test",
      hostRoots: [],
      guardPorts: [],
    });
  });

  it("does not start an unpaired target", async () => {
    fake.read.mockResolvedValue(null);
    await fixture().service.activate("https://example.test");
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("does not start a pairing for another target", async () => {
    fake.read.mockResolvedValue({ apiUrl: "https://other.test", hostRoots: [] });
    await fixture().service.activate("https://example.test");
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("does not start a pairing owned by local mode", async () => {
    fake.read.mockResolvedValue({ apiUrl: LOCAL_ORIGIN, hostRoots: [] });
    await fixture(LOCAL_ORIGIN).service.activate(LOCAL_ORIGIN);
    expect(fake.read).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("does not read or start a pairing without secure storage", async () => {
    fake.storageAvailable = false;
    await fixture().service.activate("https://example.test");
    expect(fake.read).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();
  });

  it("stops when the active target changes while the pairing is read", async () => {
    let finishRead!: (value: unknown) => void;
    fake.read.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishRead = resolve;
        }),
    );
    const f = fixture();
    const activation = f.service.activate("https://example.test");
    await vi.waitFor(() => expect(fake.read).toHaveBeenCalledOnce());
    f.changeTarget("https://other.test");
    finishRead({ apiUrl: "https://example.test", hostRoots: [] });
    await activation;
    expect(fake.start).not.toHaveBeenCalled();
    expect(fake.stop).toHaveBeenCalledOnce();
  });

  it("rejects an insecure non-loopback target and stops after clear", async () => {
    const insecure = fixture("http://example.test");
    await insecure.service.activate("http://example.test");
    expect(fake.read).not.toHaveBeenCalled();
    expect(fake.start).not.toHaveBeenCalled();

    const paired = fixture();
    await paired.service.activate("https://example.test");
    await fake.handlers.get("desktop.host.clear")!(paired.event);
    expect(fake.start).toHaveBeenCalledOnce();
    expect(fake.stop).toHaveBeenCalledTimes(2);
    expect(fake.clear).toHaveBeenCalledOnce();
  });
});
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

function stubLoopbackPorts() {
  vi.stubEnv("DATABASE_URL", "postgres://app:fake-db-marker@127.0.0.1:23456/ardurbot");
  vi.stubEnv("SANDBOX_SUPERVISOR_URL", "http://127.0.0.1:17091");
  vi.stubEnv("REALTIME_DATABASE_URL", "postgres://app@10.1.2.3:5432/remote");
}

function pairResponse(body: unknown, status = 200) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

describe("pairing port list", () => {
  const stored = {
    apiUrl: "https://example.test",
    token: PAIR_TOKEN,
    root: "/fixture/host-service/workspaces",
    hostRoots: [] as string[],
  };

  it("blocks the known loopback ports when the pair response omits the list", async () => {
    stubLoopbackPorts();
    fake.read.mockResolvedValue(null);
    const f = fixture();
    f.fetch.mockResolvedValue(pairResponse({ token: PAIR_TOKEN }));
    await f.handler("setup")(f.event);
    const config = { ...stored, guardPorts: [23456, 17091] };
    expect(fake.write).toHaveBeenCalledWith(config);
    expect(fake.start).toHaveBeenCalledWith(config);
    expect(JSON.stringify(fake.write.mock.calls)).not.toContain("fake-db-marker");
    expect(JSON.stringify(fake.start.mock.calls)).not.toContain("fake-db-marker");
  });

  it("adds the known loopback ports to an empty pair list", async () => {
    stubLoopbackPorts();
    fake.read.mockResolvedValue(null);
    const f = fixture();
    f.fetch.mockResolvedValue(pairResponse({ token: PAIR_TOKEN, guardPorts: [] }));
    await f.handler("setup")(f.event);
    const config = { ...stored, guardPorts: [23456, 17091] };
    expect(fake.write).toHaveBeenCalledWith(config);
    expect(fake.start).toHaveBeenCalledWith(config);
    expect(JSON.stringify(fake.write.mock.calls)).not.toContain("fake-db-marker");
  });

  it("adds the known loopback ports to the pair list", async () => {
    stubLoopbackPorts();
    fake.read.mockResolvedValue(null);
    const f = fixture();
    f.fetch.mockResolvedValue(pairResponse({ token: PAIR_TOKEN, guardPorts: [55433] }));
    await f.handler("setup")(f.event);
    const guardPorts = [55433, 23456, 17091];
    expect(fake.write).toHaveBeenCalledWith({ ...stored, guardPorts });
    expect(fake.start).toHaveBeenCalledWith(expect.objectContaining({ guardPorts }));
    expect(JSON.stringify(fake.start.mock.calls)).not.toContain("fake-db-marker");
  });

  it("adds a loopback realtime port as well as the database and supervisor", async () => {
    stubLoopbackPorts();
    vi.stubEnv("REALTIME_DATABASE_URL", "postgres://app@127.0.0.1:23457/ardurbot");
    fake.read.mockResolvedValue(null);
    const f = fixture();
    f.fetch.mockResolvedValue(pairResponse({ token: PAIR_TOKEN, guardPorts: [55433] }));
    await f.handler("setup")(f.event);
    expect(fake.start).toHaveBeenCalledWith(
      expect.objectContaining({ guardPorts: [55433, 23456, 23457, 17091] }),
    );
  });

  it("starts a reconnect that has no stored port list with the known loopback ports", async () => {
    stubLoopbackPorts();
    fake.read.mockResolvedValue(stored);
    const f = fixture();
    f.fetch.mockResolvedValue(pairResponse({ error: "Disconnect the existing host" }, 409));
    await f.handler("setup")(f.event);
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.start).toHaveBeenCalledWith({ ...stored, guardPorts: [23456, 17091] });
  });

  it("adds the known loopback ports when a reconnect stored an empty list", async () => {
    stubLoopbackPorts();
    const empty = { ...stored, guardPorts: [] as number[] };
    fake.read.mockResolvedValue(empty);
    const f = fixture();
    f.fetch.mockResolvedValue(pairResponse({ error: "Disconnect the existing host" }, 409));
    await f.handler("setup")(f.event);
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.start).toHaveBeenCalledWith({ ...empty, guardPorts: [23456, 17091] });
  });

  it("restores an older pairing with the known loopback ports", async () => {
    stubLoopbackPorts();
    const older = { ...stored, hostRoots: ["/fixture/projects"] };
    fake.read.mockResolvedValue(older);
    const f = fixture();
    await f.service.activate("https://example.test");
    expect(fake.write).not.toHaveBeenCalled();
    expect(fake.start).toHaveBeenCalledWith({ ...older, guardPorts: [23456, 17091] });
  });

  it("fills a missing port list when a folder is added", async () => {
    stubLoopbackPorts();
    fake.read.mockResolvedValue({ ...stored });
    const f = fixture();
    fake.picker.mockResolvedValue({ canceled: false, filePaths: ["/fixture/approved"] });
    await f.add(f.event, "/fixture/approved");
    expect(fake.write).toHaveBeenCalledWith({ ...stored, hostRoots: ["/fixture/approved"] });
    expect(fake.start).toHaveBeenCalledWith({
      ...stored,
      hostRoots: ["/fixture/approved"],
      guardPorts: [23456, 17091],
    });
    expect(JSON.stringify(fake.write.mock.calls)).not.toContain("fake-db-marker");
  });
});
