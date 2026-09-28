import {
  GUIDED_SETUP_CHANNELS,
  SetupNoInputSchema,
  SetupSnapshotSchema,
  SetupStepInputSchema,
} from "@ardurbot/contracts/desktop-setup";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { SetupEngine } from "./engine.js";

export function installGuidedSetupIpc(input: {
  ipc: Pick<IpcMain, "handle" | "removeHandler">;
  window: () => BrowserWindow | null;
  engine: SetupEngine;
}): () => void {
  const allowed = (event: IpcMainInvokeEvent) => {
    const window = input.window();
    return (
      window !== null &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame
    );
  };
  const guard = (event: IpcMainInvokeEvent) => {
    if (!allowed(event)) throw new Error("Setup window is not active.");
  };
  input.ipc.handle(GUIDED_SETUP_CHANNELS.snapshot, (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    return SetupSnapshotSchema.parse(input.engine.snapshot());
  });
  input.ipc.handle(GUIDED_SETUP_CHANNELS.start, async (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    return SetupSnapshotSchema.parse(await input.engine.start());
  });
  input.ipc.handle(
    GUIDED_SETUP_CHANNELS.retry,
    async (event, value: unknown, ...extra: unknown[]) => {
      guard(event);
      SetupNoInputSchema.parse(extra);
      return SetupSnapshotSchema.parse(await input.engine.retry(SetupStepInputSchema.parse(value)));
    },
  );
  input.ipc.handle(
    GUIDED_SETUP_CHANNELS.skip,
    async (event, value: unknown, ...extra: unknown[]) => {
      guard(event);
      SetupNoInputSchema.parse(extra);
      return SetupSnapshotSchema.parse(await input.engine.skip(SetupStepInputSchema.parse(value)));
    },
  );
  input.ipc.handle(GUIDED_SETUP_CHANNELS.cancel, async (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    return SetupSnapshotSchema.parse(await input.engine.cancel());
  });
  input.ipc.handle(GUIDED_SETUP_CHANNELS.resume, async (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    return SetupSnapshotSchema.parse(await input.engine.resume());
  });
  const unsubscribe = input.engine.onChange((snapshot) => {
    const window = input.window();
    if (window && !window.isDestroyed()) {
      window.webContents.send(GUIDED_SETUP_CHANNELS.changed, SetupSnapshotSchema.parse(snapshot));
    }
  });
  return () => {
    unsubscribe();
    for (const channel of Object.values(GUIDED_SETUP_CHANNELS)) {
      if (channel !== GUIDED_SETUP_CHANNELS.changed) input.ipc.removeHandler(channel);
    }
  };
}
