import { GUIDED_SETUP_CHANNELS } from "@ardurbot/contracts/desktop-setup";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { describe, expect, it, vi } from "vitest";
import { SetupEngine } from "./engine.js";
import { installGuidedSetupIpc } from "./ipc.js";
import type { JournalFileBoundary } from "./store.js";
import { SetupJournalStore } from "./store.js";

describe("guided setup IPC", () => {
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
    const frame = {};
    const send = vi.fn();
    const webContents = { mainFrame: frame, send };
    const window = { isDestroyed: () => false, webContents } as unknown as BrowserWindow;
    const cleanup = installGuidedSetupIpc({ ipc, window: () => window, engine });
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
