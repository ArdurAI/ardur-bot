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
  startup: { supported(): boolean; enabled(): boolean; set(enabled: boolean): void };
  openAccount?: (step: "model" | "first-bot" | "finish") => Promise<void>;
}): () => void {
  let startupBefore: boolean | null = null;
  const allowed = (event: IpcMainInvokeEvent) => {
    const window = input.window();
    let localDocument = false;
    try {
      const url = new URL(event.senderFrame?.url ?? "");
      localDocument = url.protocol === "file:" && url.pathname.endsWith("/guided-setup.html");
    } catch {
      // A missing or malformed frame URL cannot authorize machine actions.
    }
    return (
      window !== null &&
      !window.isDestroyed() &&
      event.sender === window.webContents &&
      event.senderFrame === window.webContents.mainFrame &&
      localDocument
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
    const stopped = await input.engine.cancel();
    if (
      startupBefore !== null &&
      stopped.steps.find((row) => row.id === "services")?.status !== "succeeded"
    ) {
      input.startup.set(startupBefore);
      startupBefore = null;
    }
    return SetupSnapshotSchema.parse(stopped);
  });
  input.ipc.handle(
    GUIDED_SETUP_CHANNELS.startup,
    (event, enabled: unknown, ...extra: unknown[]) => {
      guard(event);
      SetupNoInputSchema.parse(extra);
      if (typeof enabled !== "boolean" || !input.startup.supported())
        throw new Error("Run on startup is unavailable on this computer.");
      const row = input.engine.snapshot().steps.find((step) => step.id === "services");
      if (row?.status !== "waiting-input") throw new Error("Finish the current setup step first.");
      if (startupBefore === null) startupBefore = input.startup.enabled();
      try {
        input.startup.set(enabled);
        return { ok: true, enabled: input.startup.enabled() };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error &&
            (error.message === "Allow startup in your system settings, then try again." ||
              error.message === "Startup could not be restored. Check your system settings.")
              ? error.message
              : "Could not change startup. Try again.",
        };
      }
    },
  );
  input.ipc.handle(GUIDED_SETUP_CHANNELS.startupState, (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    const supported = input.startup.supported();
    return { supported, enabled: supported && input.startup.enabled() };
  });
  input.ipc.handle(GUIDED_SETUP_CHANNELS.resume, async (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    return SetupSnapshotSchema.parse(await input.engine.resume());
  });
  input.ipc.handle(GUIDED_SETUP_CHANNELS.openModels, async (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    await input.openAccount?.("model");
  });
  input.ipc.handle(GUIDED_SETUP_CHANNELS.createBot, async (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    await input.openAccount?.("first-bot");
  });
  input.ipc.handle(GUIDED_SETUP_CHANNELS.openApp, async (event, ...args: unknown[]) => {
    guard(event);
    SetupNoInputSchema.parse(args);
    if (input.engine.snapshot().steps[8]?.status !== "succeeded")
      throw new Error("Finish setup first.");
    await input.openAccount?.("finish");
  });
  const unsubscribe = input.engine.onChange((snapshot) => {
    if (snapshot.steps.find((row) => row.id === "services")?.status === "succeeded")
      startupBefore = null;
    const window = input.window();
    if (window && !window.isDestroyed()) {
      window.webContents.send(GUIDED_SETUP_CHANNELS.changed, SetupSnapshotSchema.parse(snapshot));
    }
  });
  return () => {
    unsubscribe();
    for (const channel of Object.values(GUIDED_SETUP_CHANNELS)) {
      if (
        channel !== GUIDED_SETUP_CHANNELS.changed &&
        channel !== GUIDED_SETUP_CHANNELS.openAgain &&
        channel !== GUIDED_SETUP_CHANNELS.returnToSetup &&
        channel !== GUIDED_SETUP_CHANNELS.refreshAccount
      )
        input.ipc.removeHandler(channel);
    }
  };
}
