import { GUIDED_SETUP_CHANNELS } from "@ardurbot/contracts/desktop-setup";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { SetupEngine } from "./engine.js";
import { installGuidedSetupIpc } from "./ipc.js";
import type { JournalFileBoundary } from "./store.js";
import { SetupJournalStore } from "./store.js";

describe("guided setup IPC", () => {
  it("surfaces startup read-back failure without failing services", async () => {
    const files: JournalFileBoundary = {
      read: async () => null,
      write: async () => undefined,
      exists: async () => false,
      ensure: async () => undefined,
    };
    const ready = async () => ({ kind: "satisfied" as const, checkedAt: 1, evidence: "ready" });
    const engine = await SetupEngine.open(new SetupJournalStore("/fixture", files), [
      {
        id: "prerequisites",
        revision: 1,
        requires: [],
        canSkip: false,
        check: ready,
        run: async () => ({ kind: "verified", proof: "ready" }),
        verify: ready,
        cancel: async () => undefined,
      },
      {
        id: "services",
        revision: 1,
        requires: ["prerequisites"],
        canSkip: false,
        waitForInput: true,
        check: async () => ({ kind: "needed", reasonCode: "services-not-ready" }),
        run: async () => ({ kind: "owned", proof: "folder-fingerprint" }),
        verify: ready,
        cancel: async () => undefined,
      },
    ]);
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const frame = { url: "file:///fixture/guided-setup.html" };
    const webContents = { mainFrame: frame, send: vi.fn() };
    const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
    const cleanup = installGuidedSetupIpc({
      ipc: {
        handle: (
          name: string,
          handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
        ) => {
          handlers.set(name, handler);
        },
        removeHandler: (name: string) => {
          handlers.delete(name);
        },
      } as unknown as IpcMain,
      window: () => window,
      engine,
      startup: {
        supported: () => true,
        enabled: () => false,
        set: () => {
          throw new Error("Allow startup in your system settings, then try again.");
        },
      },
    });
    const call = (name: string, ...args: unknown[]) =>
      handlers.get(name)!(
        { sender: webContents, senderFrame: frame } as IpcMainInvokeEvent,
        ...args,
      );
    await call(GUIDED_SETUP_CHANNELS.start);
    expect(engine.snapshot().steps[4]?.status).toBe("waiting-input");
    expect(call(GUIDED_SETUP_CHANNELS.startup, true)).toEqual({
      ok: false,
      error: "Allow startup in your system settings, then try again.",
    });
    await call(GUIDED_SETUP_CHANNELS.retry, "services");
    expect(engine.snapshot().steps[4]?.status).toBe("succeeded");
    cleanup();
  });
  it("accepts only the setup main frame, validates inputs, sequences snapshots, and cleans up", async () => {
    let raw: string | null = null;
    const files: JournalFileBoundary = {
      read: async () => raw,
      write: async (_, value) => {
        raw = value;
      },
      exists: async () => raw !== null,
      ensure: async () => undefined,
    };
    const engine = await SetupEngine.open(
      new SetupJournalStore("/fixture/data", files),
      [
        {
          id: "prerequisites",
          revision: 1,
          requires: [],
          canSkip: false,
          check: async () => ({ kind: "satisfied", checkedAt: 1, evidence: "checked" }),
          run: async () => ({ kind: "verified", proof: "checked" }),
          verify: async () => ({ kind: "satisfied", checkedAt: 1, evidence: "checked" }),
          cancel: async () => undefined,
        },
      ],
      { monotonic: () => 1, wall: () => 1 },
    );
    const handlers = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
    const ipc = {
      handle: (
        name: string,
        handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown,
      ) => {
        handlers.set(name, handler);
      },
      removeHandler: (name: string) => {
        handlers.delete(name);
      },
    } as unknown as IpcMain;
    const frame = { url: "file:///fixture/guided-setup.html" };
    const send = vi.fn();
    const webContents = { mainFrame: frame, send };
    const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
    const openAccount = vi.fn(async () => undefined);
    const cleanup = installGuidedSetupIpc({
      ipc,
      window: () => window,
      engine,
      openAccount,
      startup: { supported: () => true, enabled: () => false, set: vi.fn() },
    });
    const call = (
      name: string,
      sender: unknown = webContents,
      senderFrame: unknown = frame,
      ...args: unknown[]
    ) => handlers.get(name)!({ sender, senderFrame } as IpcMainInvokeEvent, ...args);
    expect(() => call(GUIDED_SETUP_CHANNELS.snapshot, {})).toThrow("not active");
    expect(() => call(GUIDED_SETUP_CHANNELS.snapshot, webContents, {})).toThrow("not active");
    expect(() => call(GUIDED_SETUP_CHANNELS.snapshot, webContents, frame, "extra")).toThrow();
    await expect(
      call(GUIDED_SETUP_CHANNELS.retry, webContents, frame, "arbitrary-command"),
    ).rejects.toThrow();
    await expect(
      call(GUIDED_SETUP_CHANNELS.openModels, webContents, { url: "https://outside.test/" }),
    ).rejects.toThrow("not active");
    await expect(call(GUIDED_SETUP_CHANNELS.createBot, {}, frame)).rejects.toThrow("not active");
    await call(GUIDED_SETUP_CHANNELS.openModels);
    expect(openAccount).toHaveBeenCalledWith("model");
    const before = call(GUIDED_SETUP_CHANNELS.snapshot) as ReturnType<typeof engine.snapshot>;
    await call(GUIDED_SETUP_CHANNELS.start);
    const after = call(GUIDED_SETUP_CHANNELS.snapshot) as ReturnType<typeof engine.snapshot>;
    expect(after.sequence).toBeGreaterThan(before.sequence);
    expect(send).toHaveBeenCalledWith(
      GUIDED_SETUP_CHANNELS.changed,
      expect.objectContaining({ sequence: after.sequence }),
    );
    cleanup();
    expect(handlers.size).toBe(0);
  });
});
