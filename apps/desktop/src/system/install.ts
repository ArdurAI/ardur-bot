import type { BrowserWindow } from "electron";
import { app, globalShortcut, ipcMain, powerSaveBlocker, shell, systemPreferences } from "electron";
import type { SystemDependencies } from "./controller.js";
import { SystemController } from "./controller.js";
import { systemSenderAllowed } from "./sender.js";
import { SystemStore } from "./store.js";

export { systemSenderAllowed };

/** Called by the main-process composition root after app.whenReady(). */
export async function installDesktopSystem(
  options: Pick<
    SystemDependencies,
    "mode" | "dataFolder" | "routines" | "shortcut" | "menuBar" | "storage" | "localData"
  > & {
    window(): BrowserWindow | null;
    target(): string | null;
  },
) {
  const controller = new SystemController({
    ...options,
    platform: process.platform,
    app,
    shortcuts: globalShortcut,
    power: powerSaveBlocker,
    permissions: systemPreferences,
    store: new SystemStore(app.getPath("userData")),
    openExternal: (url) => shell.openExternal(url),
  });
  try {
    await controller.initialize();
  } catch (error) {
    controller.dispose();
    throw error;
  }
  const handlers: string[] = [];
  const register = (name: string, action: (...args: unknown[]) => unknown) => {
    const channel = `desktop.system.${name}`;
    handlers.push(channel);
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!systemSenderAllowed(event, options.window(), options.target()))
        throw new Error("Open System settings in the desktop app.");
      return action(...args);
    });
  };
  register("state", () => controller.state());
  register("set", (key, value) => controller.set(key, value));
  register("moveStorage", (recommended) => controller.moveStorage(recommended));
  register("resetLocalData", () => controller.resetLocalData());
  register("openPermission", (permission) => {
    if (permission !== "screen" && permission !== "accessibility")
      throw new Error("Choose an available permission.");
    return controller.openPermission(permission);
  });
  const timer = setInterval(() => void controller.refreshRoutines(), 30_000);
  timer.unref();
  const dispose = () => {
    clearInterval(timer);
    controller.dispose();
    for (const channel of handlers) ipcMain.removeHandler(channel);
    app.removeListener("will-quit", dispose);
  };
  app.once("will-quit", dispose);
  return { controller, dispose };
}
