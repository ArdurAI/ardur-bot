import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { cliVersion } from "../cli.js";
import { DEFAULT_PREFERENCES } from "./contract.js";
import { SystemController } from "./controller.js";
import { SystemStore } from "./store.js";

function fixture(platform = "darwin") {
  let login = false;
  const deps = {
    platform,
    app: {
      getVersion: () => "0.1.0-alpha.1",
      getLoginItemSettings: () => ({ openAtLogin: login, executableWillLaunchAtLogin: login }),
      setLoginItemSettings: vi.fn((settings: { openAtLogin?: boolean }) => {
        login = settings.openAtLogin ?? false;
      }),
    },
    shortcuts: { register: vi.fn(() => true), unregister: vi.fn() },
    power: { start: vi.fn(() => 9), stop: vi.fn() },
    permissions: {
      isTrustedAccessibilityClient: vi.fn(() => true),
      getMediaAccessStatus: vi.fn(() => "granted"),
    },
    store: {
      read: vi.fn(async () => ({ ...DEFAULT_PREFERENCES })),
      write: vi.fn(async () => undefined),
    },
    mode: vi.fn(() => "new" as "new" | "existing"),
    dataFolder: () => null,
    routines: vi.fn(async () => 2),
    shortcut: vi.fn(),
    menuBar: vi.fn(),
    openExternal: vi.fn(async () => undefined),
  };
  return { deps, controller: new SystemController(deps) };
}

describe("system controller", () => {
  it("uses the same packaged version source as --version", async () => {
    const f = fixture();
    await f.controller.initialize();
    expect(`${f.controller.state().version}\n`).toBe(
      cliVersion(["--version"], f.deps.app.getVersion()),
    );
  });
  it("serializes simultaneous changes without losing saved preferences", async () => {
    const f = fixture();
    await f.controller.initialize();
    await Promise.all([
      f.controller.set("keepAwake", true),
      f.controller.set("openLinksInBrowser", true),
    ]);
    expect(f.deps.store.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ keepAwake: true, openLinksInBrowser: true }),
    );
    expect(f.controller.state().awakeRoutines).toBe(2);
  });
  it("starts and stops independently of a settings renderer", async () => {
    const f = fixture();
    f.deps.store.read.mockResolvedValueOnce({ ...DEFAULT_PREFERENCES, keepAwake: true });
    await f.controller.initialize();
    expect(f.deps.power.start).toHaveBeenCalledOnce();
    f.deps.routines.mockResolvedValueOnce(0);
    await f.controller.refreshRoutines();
    expect(f.deps.power.stop).toHaveBeenCalledWith(9);
  });
  it("does not retain awake status when the routine backend is unavailable", async () => {
    const f = fixture();
    await f.controller.initialize();
    await f.controller.set("keepAwake", true);
    f.deps.routines.mockRejectedValueOnce(new Error("offline"));
    await f.controller.refreshRoutines();
    expect(f.controller.state().awakeRoutines).toBe(0);
  });
  it("restores native state after a persistence failure", async () => {
    const f = fixture();
    await f.controller.initialize();
    f.deps.store.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.controller.set("runOnStartup", true)).rejects.toThrow("Could not save");
    expect(f.controller.state().preferences.runOnStartup).toBe(false);
    f.deps.store.write.mockRejectedValueOnce(new Error("disk full"));
    await expect(f.controller.set("quickAccess", "Alt+Space")).rejects.toThrow("Could not save");
    expect(f.deps.shortcuts.unregister).toHaveBeenCalledWith("Alt+Space");
    expect(f.controller.state().preferences.quickAccess).toBe("Off");
  });
  it("reports startup shortcut conflicts and lets the user recover", async () => {
    const f = fixture();
    f.deps.store.read.mockResolvedValueOnce({ ...DEFAULT_PREFERENCES, quickAccess: "Alt+Space" });
    f.deps.shortcuts.register.mockReturnValueOnce(false);
    await f.controller.initialize();
    expect(f.controller.state().shortcutError).toBe(true);
    await f.controller.set("quickAccess", "Off");
    expect(f.controller.state().shortcutError).toBe(false);
  });
  it("hides managed storage and refuses moves in existing-instance mode", async () => {
    const f = fixture();
    f.deps.mode.mockReturnValue("existing");
    await f.controller.initialize();
    expect(f.controller.state().storage).toEqual({ path: null, canMove: false, progress: null });
    await expect(f.controller.moveStorage(false)).rejects.toThrow("managed by the server");
  });
  it("resets local data only while this app keeps it", async () => {
    const f = fixture();
    let local = false;
    const reset = vi.fn(async () => true);
    const controller = new SystemController({
      ...f.deps,
      localData: { available: () => local, reset },
    });
    await controller.initialize();
    expect(controller.state().localData).toBe(false);
    await expect(controller.resetLocalData()).rejects.toThrow("managed by the server");
    expect(reset).not.toHaveBeenCalled();
    local = true;
    expect((await controller.resetLocalData()).localData).toBe(true);
    expect(reset).toHaveBeenCalledOnce();
  });
  it("ignores a delayed routine result after quitting", async () => {
    const f = fixture();
    await f.controller.initialize();
    await f.controller.set("keepAwake", true);
    let finish!: (count: number) => void;
    f.deps.routines.mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const pending = f.controller.refreshRoutines();
    f.controller.dispose();
    finish(4);
    await pending;
    expect(f.controller.state().awakeRoutines).toBe(0);
    expect(f.deps.power.start).toHaveBeenCalledOnce();
    await expect(f.controller.set("quickAccess", "Alt+Space")).rejects.toThrow();
  });
  it.each(["__proto__", "constructor", "storage", "dispatch"])(
    "rejects unknown IPC setting %s",
    async (key) => {
      const f = fixture();
      await expect(f.controller.set(key, true)).rejects.toThrow("available setting");
      expect(f.deps.store.write).not.toHaveBeenCalled();
    },
  );
  it.each(["win32", "linux"])("refuses macOS actions on %s", async (platform) => {
    const f = fixture(platform);
    await f.controller.initialize();
    await expect(f.controller.set("menuBar", true)).rejects.toThrow("unavailable");
    await expect(f.controller.openPermission("screen")).rejects.toThrow("unavailable");
    expect(f.deps.openExternal).not.toHaveBeenCalled();
  });
  it("saves an explicit menu bar choice separately from other settings", async () => {
    const f = fixture();
    await f.controller.initialize();
    await f.controller.set("menuBar", false);
    expect(f.deps.menuBar).toHaveBeenCalledWith(false);
    expect(f.deps.store.write).toHaveBeenCalledWith(expect.objectContaining({ menuBar: false }), {
      menuBar: false,
    });
    await f.controller.set("keepAwake", true);
    expect(f.deps.store.write).toHaveBeenLastCalledWith(
      expect.objectContaining({ menuBar: false, keepAwake: true }),
    );
  });
  it("turns the menu bar on by default on macOS and keeps an explicit off", async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "system-menu-bar-"));
    try {
      const f = fixture();
      const controller = new SystemController({
        ...f.deps,
        store: new SystemStore(directory, "darwin"),
      });
      await controller.initialize();
      expect(f.deps.menuBar).toHaveBeenCalledWith(true);
      expect(controller.state().preferences.menuBar).toBe(true);
      await controller.set("menuBar", false);
      const reloaded = new SystemController({
        ...f.deps,
        store: new SystemStore(directory, "darwin"),
      });
      await reloaded.initialize();
      expect(reloaded.state().preferences.menuBar).toBe(false);
      expect(f.deps.menuBar).toHaveBeenLastCalledWith(false);
      await reloaded.set("keepAwake", true);
      expect((await new SystemStore(directory, "darwin").read()).menuBar).toBe(false);
      expect((await new SystemStore(directory, "linux").read()).menuBar).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(["linux", "win32"])("leaves the menu bar off by default on %s", async (platform) => {
    const directory = await mkdtemp(path.join(os.tmpdir(), "system-menu-bar-"));
    try {
      const f = fixture(platform);
      const controller = new SystemController({
        ...f.deps,
        store: new SystemStore(directory, platform),
      });
      await controller.initialize();
      expect(f.deps.menuBar).not.toHaveBeenCalled();
      expect(controller.state().preferences.menuBar).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

it("keeps the app usable if a saved menu bar item cannot be created", async () => {
  const f = fixture();
  f.deps.store.read.mockResolvedValueOnce({ ...DEFAULT_PREFERENCES, menuBar: true });
  f.deps.menuBar.mockImplementationOnce(() => {
    throw new Error("No tray host");
  });
  await f.controller.initialize();
  expect(f.controller.state().preferences.menuBar).toBe(false);
  expect(f.controller.state().menuBarError).toBe(true);
  await f.controller.set("menuBar", true);
  expect(f.controller.state().menuBarError).toBe(false);
});
